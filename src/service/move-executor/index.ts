/**
 * `MoveExecutor` (§9.3, Appendix G §7.5): the per-tab façade the `GameSession`
 * (Task 30) drives. `arm()` attaches the debugger (arm time, waiting view —
 * never mid-game, §13.4) and hands the pointer to the virtual hand (§13.5);
 * `schedule(rec, plan)` runs the hand so the drop lands on `plan.deadlineMs`
 * (the pre-touch window shrinks when the engine already used part of the
 * think time; a plan whose deadline is far off waits on the injected
 * scheduler); `playNow()` executes the pending move with an instant plan;
 * `cancel()` aborts (a held piece is dropped at once). Every execution is
 * verified through the content adapter and retried once in the other tier
 * (`retry-policy.ts`); the outcome is emitted as `executed | failed |
 * aborted | skipped`, hand-state changes as `hand`.
 */

import { isSquare } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply, ExpectedMove } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { perGameProfile, perMoveProfile, profileFor } from "@core/motor/motor-profile";
import { plausibleStart } from "@core/motor/sampling";
import type {
	ClickStyle,
	ExecutionPlan,
	ExecutionResult,
	HandState,
	MotorMoveKind,
	MoveCandidate,
	Pt,
	TimeControlClass,
} from "@core/motor/types";
import { createRng } from "@core/rng";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler, sleep } from "@core/util/scheduler";
import type { ReplyFor, RequestInput, RequestKind } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { HandOwnership } from "@service/hand-ownership";
import type { GameSessionView, PromoPiece, Recommendation, Site, Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { TimingPlan } from "@typedefs/timing";
import { CdpInputBackend } from "./cdp-input-backend";
import {
	boardGeometryOf,
	type FocusSource,
	type GeometryProvider,
	HandController,
	preTouchMsOf,
	type TimingWindow,
} from "./hand-controller";
import { otherTier, runWithRetry } from "./retry-policy";
import { type VerifyResult, verifyMove } from "./verifier";

/** The slice of `ContentLink` the executor needs (geometry + verification requests). */
export interface ExecutorLink {
	request<K extends RequestKind>(
		tabId: number,
		cmd: RequestInput<K>,
		timeoutMs: number
	): Promise<ReplyFor<K>>;
}

export interface ExecutorGameConfig {
	persona: PersonaId;
	tcClass: TimeControlClass;
	/** `Settings.execution.style`: `auto` picks a per-game dominant style (70/30). */
	style: ClickStyle | "auto";
	/** `Settings.execution.previewSelectScale`, 0 when previews are off. */
	previewScale: number;
	/** Seeds the per-game hand (profile offsets, dominant styles). */
	gameSeed: number | string;
	/** `Settings.execution.verifyMoves` (default true). */
	verifyMoves?: boolean;
}

export interface MoveExecutorDeps extends ExecutorGameConfig {
	tabId: number;
	site: Site;
	debugger: DebuggerManager;
	link: ExecutorLink;
	focus: FocusSource;
	ownership: HandOwnership;
	now?: () => number;
	scheduler?: Scheduler;
}

/** Per-move context the session knows and the recommendation does not carry. */
export interface MoveContext {
	myClockMs?: number;
	nReasonable?: number;
	candidates?: readonly MoveCandidate[];
	legalDestinations?: (sq: Square) => Square[];
	moveKind?: MotorMoveKind;
}

export interface ExecutionReport {
	rec: Recommendation;
	result: ExecutionResult;
}

export interface ExecutorEvents {
	executed: ExecutionReport;
	failed: ExecutionReport;
	aborted: ExecutionReport;
	skipped: ExecutionReport;
	hand: HandState;
}
export type ExecutorEvent = keyof ExecutorEvents;

interface Pending {
	rec: Recommendation;
	timing: TimingPlan;
	ctx: MoveContext;
	fireAt: number;
	timer: unknown;
}

interface Running {
	rec: Recommendation;
	ac: AbortController;
	done: Promise<ExecutionResult>;
}

type WindowedTimingPlan = TimingPlan & { window?: TimingWindow };

function withoutWindow(plan: TimingPlan): TimingPlan {
	const copy: WindowedTimingPlan = { ...plan };
	delete copy.window;
	return copy;
}

/** An instant plan for `playNow` and retries: no exploration, touch only. */
export function instantTiming(plan: TimingPlan): TimingPlan {
	return {
		...withoutWindow(plan),
		mode: "instant",
		thinkMs: EXECUTOR.minExecutionMs + plan.dragDurationMs,
		preMoveHoverMs: 0,
	};
}

/**
 * The plan the hand runs when only `availableMs` remain until the deadline:
 * the touch budget is kept and the pre-touch window absorbs the loss.
 */
export function fitTiming(plan: TimingPlan, availableMs: number): TimingPlan {
	if (availableMs >= plan.thinkMs) return plan;
	const touchBudget = EXECUTOR.defaultApproachMs + plan.dragDurationMs;
	const thinkMs = Math.max(EXECUTOR.minExecutionMs, availableMs);
	const preTouch = Math.max(0, Math.min(preTouchMsOf(plan), thinkMs - touchBudget));
	return { ...withoutWindow(plan), thinkMs, preMoveHoverMs: preTouch };
}

/** Exploration candidates from the MultiPV lines, weighted by rank when the session gives no probabilities. */
export function candidatesFromLines(rec: Recommendation): MoveCandidate[] {
	const out: MoveCandidate[] = [];
	rec.lines.forEach((line, i) => {
		const uci = line.pvUci[0];
		if (!uci || uci.length < 4) return;
		const from = uci.slice(0, 2);
		const to = uci.slice(2, 4);
		if (!isSquare(from) || !isSquare(to)) return;
		out.push({ from, to, uci, probability: 1 / (i + 1) });
	});
	return out;
}

const HAND_VIEW: Record<HandState, GameSessionView["hand"]> = {
	rest: "resting",
	orientation: "exploring",
	exploring: "exploring",
	approaching: "moving",
	grabbing: "moving",
	dragging: "moving",
	dropping: "moving",
	correcting: "moving",
	promoting: "moving",
};

export class MoveExecutor {
	private readonly tabId: number;
	private readonly site: Site;
	private readonly debugger: DebuggerManager;
	private readonly link: ExecutorLink;
	private readonly focus: FocusSource;
	private readonly ownership: HandOwnership;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly config: ExecutorGameConfig;
	private readonly dominantStyle: ClickStyle;
	private readonly geometry: GeometryProvider;
	private readonly listeners = new Map<ExecutorEvent, Set<(payload: never) => void>>();
	private pending: Pending | null = null;
	private running: Running | null = null;
	private hand: HandState = "rest";
	private lastSkipReason: string | null = null;
	private disposed = false;

	constructor(deps: MoveExecutorDeps) {
		this.tabId = deps.tabId;
		this.site = deps.site;
		this.debugger = deps.debugger;
		this.link = deps.link;
		this.focus = deps.focus;
		this.ownership = deps.ownership;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.config = {
			persona: deps.persona,
			tcClass: deps.tcClass,
			style: deps.style,
			previewScale: deps.previewScale,
			gameSeed: deps.gameSeed,
			verifyMoves: deps.verifyMoves ?? true,
		};
		const gameRng = createRng(`${deps.gameSeed}:style`);
		this.dominantStyle =
			deps.style === "auto"
				? gameRng.chance(EXECUTOR.dominantStyleShare)
					? "drag"
					: "click"
				: deps.style;
		this.geometry = {
			read: (tabId, promotion) => this.readGeometry(tabId, promotion),
		};
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	/**
	 * Arm-time work (waiting view, §13.4): attach the debugger now so the
	 * infobar lands outside any move window, and transfer the pointer to the
	 * hand from the last real position / previous rest point.
	 */
	async arm(startPoint?: Pt): Promise<void> {
		await this.debugger.ensureAttached(this.tabId);
		this.ownership.armed(
			this.tabId,
			startPoint ?? this.ownership.lastRealPosition(this.tabId) ?? undefined
		);
		log.info("executor: armed", { tabId: this.tabId, start: this.ownership.position(this.tabId) });
	}

	/** The user stopped the hand: cancel anything pending and give the pointer back. */
	disarm(): void {
		this.cancel();
		this.ownership.released(this.tabId);
	}

	isArmed(): boolean {
		return this.ownership.isArmed(this.tabId) && this.debugger.isAttached(this.tabId);
	}

	handState(): HandState {
		return this.hand;
	}

	/** The panel's hand pill (§9.7). */
	handView(): GameSessionView["hand"] {
		if (!this.debugger.isAttached(this.tabId)) return "detached";
		if (this.hand === "rest" && this.lastSkipReason !== null) return "paused";
		return HAND_VIEW[this.hand];
	}

	pendingMove(): { rec: Recommendation; fireAt: number } | null {
		return this.pending ? { rec: this.pending.rec, fireAt: this.pending.fireAt } : null;
	}

	isRunning(): boolean {
		return this.running !== null;
	}

	on<E extends ExecutorEvent>(event: E, cb: (payload: ExecutorEvents[E]) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(cb as (payload: never) => void);
		return () => void set?.delete(cb as (payload: never) => void);
	}

	// ── scheduling ────────────────────────────────────────────────────────

	/** Run the hand so the move completes at `plan.deadlineMs`. Replaces any pending move. */
	schedule(rec: Recommendation, plan: TimingPlan, ctx: MoveContext = {}): void {
		if (this.disposed) return;
		this.clearPending();
		const now = this.now();
		const available = plan.deadlineMs - now;
		const fireAt = available > plan.thinkMs ? plan.deadlineMs - plan.thinkMs : now;
		const timing = fitTiming(plan, available);
		const timer = this.scheduler.setTimeout(
			() => {
				this.pending = null;
				void this.execute(rec, timing, ctx);
			},
			Math.max(0, fireAt - now)
		);
		this.pending = { rec, timing, ctx, fireAt, timer };
		log.debug("executor: scheduled", {
			tabId: this.tabId,
			uci: rec.chosen.uci,
			fireInMs: fireAt - now,
			thinkMs: timing.thinkMs,
		});
	}

	/** Execute the pending move (or `rec`) right away with an instant plan. */
	async playNow(
		rec?: Recommendation,
		plan?: TimingPlan,
		ctx?: MoveContext
	): Promise<ExecutionResult | null> {
		const pending = this.pending;
		this.clearPending();
		const target = rec ?? pending?.rec;
		const base = plan ?? pending?.timing;
		if (!target || !base) return null;
		return this.execute(target, instantTiming(base), ctx ?? pending?.ctx ?? {});
	}

	/** Drop the pending move; abort a running one (the hand releases at once). */
	cancel(): void {
		this.clearPending();
		this.running?.ac.abort();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel();
		this.listeners.clear();
	}

	// ── execution ─────────────────────────────────────────────────────────

	/**
	 * One execution at a time per tab. A second request while the hand is busy is
	 * dropped (the running execution's promise is returned): the session owns the
	 * "one recommendation per position" rule and must `cancel()` before
	 * scheduling a replacement — queueing here would play a stale move.
	 * (Queued for Task 30: decide whether a newer recommendation should abort the
	 * running one instead.)
	 */
	private async execute(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext
	): Promise<ExecutionResult> {
		if (this.running) {
			log.warn("executor: execution already running; request dropped (cancel() first)", {
				tabId: this.tabId,
				uci: rec.chosen.uci,
			});
			return this.running.done;
		}
		const ac = new AbortController();
		const done = this.runOne(rec, timing, ctx, ac.signal);
		this.running = { rec, ac, done };
		try {
			return await done;
		} finally {
			this.running = null;
		}
	}

	private async runOne(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		signal: AbortSignal
	): Promise<ExecutionResult> {
		const t0 = this.now();
		const fail = (reason: string, error?: string): ExecutionResult => {
			const r: ExecutionResult = {
				ok: false,
				outcome: "failed",
				reason,
				tier: this.dominantStyle,
				attempts: 0,
				endPoint: this.ownership.position(this.tabId) ?? { x: 0, y: 0 },
				elapsedMs: this.now() - t0,
				timeline: [],
			};
			if (error !== undefined) r.error = error;
			return r;
		};
		let result: ExecutionResult;
		try {
			if (!this.debugger.isAttached(this.tabId)) {
				log.warn("executor: debugger not attached at execution time (arm first)", {
					tabId: this.tabId,
					lastError: this.debugger.lastError(this.tabId) ?? null,
				});
				result = fail(EXECUTOR.reasons.notAttached);
			} else {
				const reply = await this.readGeometry(this.tabId);
				if (!reply) result = fail(EXECUTOR.reasons.noGeometry);
				else result = await this.dispatch(rec, timing, ctx, reply, signal);
			}
		} catch (error) {
			result = fail(EXECUTOR.reasons.dispatchFailed, errorMessage(error));
		}
		this.setHand("rest");
		this.lastSkipReason = result.outcome === "skipped" ? (result.reason ?? null) : null;
		this.emit(
			result.outcome === "executed"
				? "executed"
				: result.outcome === "aborted"
					? "aborted"
					: result.outcome === "skipped"
						? "skipped"
						: "failed",
			{ rec, result }
		);
		return result;
	}

	private async dispatch(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		reply: BoardGeometryReply,
		signal: AbortSignal
	): Promise<ExecutionResult> {
		const readAt = this.now();
		const geo = boardGeometryOf(reply);
		const fromRect = geo.squareRect(rec.chosen.from);
		const toRect = geo.squareRect(rec.chosen.to);
		const moveRng = createRng(`${this.config.gameSeed}:${rec.fen}:${rec.chosen.uci}`);
		const style = this.styleFor(moveRng);
		const moveKind = ctx.moveKind ?? this.moveKindOf(rec);
		const motor = perMoveProfile(
			perGameProfile(
				profileFor(this.config.persona, this.config.tcClass, moveKind),
				createRng(`${this.config.gameSeed}:hand`)
			),
			moveRng
		);
		const start =
			this.ownership.position(this.tabId) ?? plausibleStart(geo.boardRect, moveRng, fromRect);
		this.ownership.setPosition(this.tabId, start);
		const backend = CdpInputBackend.forTab(this.debugger, this.tabId, start, {
			now: this.now,
			scheduler: this.scheduler,
		});
		const controller = new HandController({
			backend,
			focus: this.focus,
			ownership: this.ownership,
			geometry: this.geometry,
			rng: moveRng,
			now: this.now,
			scheduler: this.scheduler,
			onState: (s) => this.setHand(s),
		});
		const plan: ExecutionPlan = {
			tabId: this.tabId,
			site: this.site,
			from: {
				x: fromRect.left + fromRect.width / 2,
				y: fromRect.top + fromRect.height / 2,
				rect: fromRect,
				square: rec.chosen.from,
			},
			to: {
				x: toRect.left + toRect.width / 2,
				y: toRect.top + toRect.height / 2,
				rect: toRect,
				square: rec.chosen.to,
			},
			style,
			motor,
			expected: { san: rec.chosen.san, uci: rec.chosen.uci, premove: rec.chosen.source === "premove" },
			geometry: { reply, readAt },
			exploration: {
				candidates: ctx.candidates ?? candidatesFromLines(rec),
				nReasonable: ctx.nReasonable ?? Math.max(1, rec.lines.length),
				myClockMs: ctx.myClockMs ?? 0,
				persona: this.config.persona,
				previewScale: this.config.previewScale,
				legalDestinations: ctx.legalDestinations ?? (() => []),
			},
		};
		if (rec.chosen.promotion) plan.promotion = rec.chosen.promotion;
		const expected: ExpectedMove = { from: rec.chosen.from, to: rec.chosen.to };
		if (rec.chosen.promotion) expected.promotion = rec.chosen.promotion;
		const verify = (timeoutMs: number): Promise<VerifyResult> =>
			this.config.verifyMoves
				? verifyMove(this.link, this.tabId, expected, timeoutMs)
				: Promise.resolve({ outcome: "ok" });
		try {
			return await runWithRetry({
				style,
				attempt: (tier, index) =>
					controller.execute(
						{ ...plan, style: tier },
						index === 0 ? timing : instantTiming(timing),
						signal
					),
				verify,
				recheck: () => verify(EXECUTOR.recheckTimeoutMs),
				delay: (ms) => sleep(ms, this.scheduler, signal),
				verifyTimeoutMs: TIMINGS.executorVerifyTimeoutMs,
				signal,
			});
		} finally {
			backend.dispose();
		}
	}

	private styleFor(moveRng: ReturnType<typeof createRng>): ClickStyle {
		if (this.config.style !== "auto") return this.config.style;
		return moveRng.chance(EXECUTOR.dominantStyleShare)
			? this.dominantStyle
			: otherTier(this.dominantStyle);
	}

	private moveKindOf(rec: Recommendation): MotorMoveKind {
		if (rec.chosen.promotion) return "promotion";
		if (rec.chosen.source === "premove") return "premove";
		return "normal";
	}

	private async readGeometry(
		tabId: number,
		promotion?: PromoPiece
	): Promise<BoardGeometryReply | null> {
		try {
			const cmd: RequestInput<"geometry"> = promotion
				? { kind: "geometry", promotion, timeoutMs: EXECUTOR.promotionPickerTimeoutMs }
				: { kind: "geometry" };
			const budget = promotion
				? EXECUTOR.promotionPickerTimeoutMs + EXECUTOR.geometryTimeoutMs
				: EXECUTOR.geometryTimeoutMs;
			const { kind: _kind, id: _id, ...reply } = await this.link.request(tabId, cmd, budget);
			return reply;
		} catch (error) {
			log.debug("executor: geometry unavailable", { tabId, error: errorMessage(error) });
			return null;
		}
	}

	private clearPending(): void {
		if (!this.pending) return;
		this.scheduler.clearTimeout(this.pending.timer);
		this.pending = null;
	}

	private setHand(s: HandState): void {
		if (this.hand === s) return;
		this.hand = s;
		this.emit("hand", s);
	}

	private emit<E extends ExecutorEvent>(event: E, payload: ExecutorEvents[E]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const cb of [...set]) {
			try {
				(cb as (p: ExecutorEvents[E]) => void)(payload);
			} catch (error) {
				log.warn("executor: listener threw", { event, error: errorMessage(error) });
			}
		}
	}
}
