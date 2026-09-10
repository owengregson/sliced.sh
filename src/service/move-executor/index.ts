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
import type { BoardRectSource } from "@service/board-watch";
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
	positionIntact,
	preTouchMsOf,
	type TimingWindow,
} from "./hand-controller";
import { otherTier, runWithRetry } from "./retry-policy";
import { checkSquares, type VerifyResult, verifyMove } from "./verifier";

/** The slice of `ContentLink` the executor needs (geometry + verification requests). */
export interface ExecutorLink {
	request<K extends RequestKind>(
		tabId: number,
		cmd: RequestInput<K>,
		timeoutMs: number,
		signal?: AbortSignal
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
	/**
	 * §9.5: the board's rect as the page last reported it. Used for the post-attach settle wait and
	 * handed to the hand as its reflow guard. Omitted: neither runs (the pre-v2.6 behaviour).
	 */
	board?: BoardRectSource;
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
	/** The plan the hand is actually working through (an instant plan for `playNow`/retries). */
	timing: TimingPlan;
	ac: AbortController;
	done: Promise<ExecutionResult>;
}

/**
 * The plan with its pre-touch window resized to `preTouchMs`: phases scale
 * proportionally (orientation alone when the plan had no pre-touch time) and
 * the approach budget is kept.
 */
function withPreTouch(plan: TimingPlan, preTouchMs: number): TimingPlan {
	const w: TimingWindow = plan.window;
	const current = preTouchMsOf(plan);
	const scale = current > 0 ? preTouchMs / current : 0;
	const window: TimingWindow =
		current > 0
			? {
					orientationMs: w.orientationMs * scale,
					scanMs: w.scanMs * scale,
					previewMs: w.previewMs * scale,
					decisionMs: w.decisionMs * scale,
					approachMs: w.approachMs,
				}
			: {
					orientationMs: preTouchMs,
					scanMs: 0,
					previewMs: 0,
					decisionMs: 0,
					approachMs: w.approachMs,
				};
	return { ...plan, preMoveHoverMs: preTouchMs, window };
}

/** An instant plan for `playNow` and retries: no exploration, touch only. */
export function instantTiming(plan: TimingPlan): TimingPlan {
	return {
		...withPreTouch(plan, 0),
		mode: "instant",
		thinkMs: EXECUTOR.minExecutionMs + plan.dragDurationMs,
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
	return { ...withPreTouch(plan, preTouch), thinkMs };
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
	private readonly board: BoardRectSource | null;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly config: ExecutorGameConfig;
	private readonly dominantStyle: ClickStyle;
	private readonly geometry: GeometryProvider;
	private readonly listeners = new Map<ExecutorEvent, Set<(payload: never) => void>>();
	private pending: Pending | null = null;
	private running: Running | null = null;
	/** A replacement waiting for a cancelled run to wind down (`cancel()`/`disarm()` drop it). */
	private parked: { rec: Recommendation; ac: AbortController } | null = null;
	/** The current board check's controller (a cancel arriving during the check aborts it). */
	private checkAc: AbortController | null = null;
	private hand: HandState = "rest";
	private lastSkipReason: string | null = null;
	/**
	 * When `arm()` actually attached the debugger, until the first execution after it has waited for
	 * the layout to settle; `null` the rest of the time. §13.4: the attach makes Chrome show its
	 * infobar, which reflows the page and moves the board, so the first execution must plan on
	 * geometry that has stopped moving.
	 */
	private attachedAt: number | null = null;
	private disposed = false;

	constructor(deps: MoveExecutorDeps) {
		this.tabId = deps.tabId;
		this.site = deps.site;
		this.debugger = deps.debugger;
		this.link = deps.link;
		this.focus = deps.focus;
		this.ownership = deps.ownership;
		this.board = deps.board ?? null;
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
			read: (tabId, promotion, signal) => this.readGeometry(tabId, promotion, signal),
		};
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	/**
	 * Arm-time work (waiting view, §13.4): attach the debugger now so the
	 * infobar lands outside any move window, and transfer the pointer to the
	 * hand from the last real position / previous rest point.
	 */
	async arm(startPoint?: Pt): Promise<void> {
		const wasAttached = this.debugger.isAttached(this.tabId);
		await this.debugger.ensureAttached(this.tabId);
		// A *fresh* attach is the one that brings the infobar; re-arming an attached tab shifts nothing.
		if (!wasAttached) this.attachedAt = this.now();
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

	/**
	 * Resolves once nothing is in flight: the execution (if any) has wound down, which means the
	 * hand's `recover()` has already released whatever button it was holding and the terminal event
	 * has been emitted. Immediate when nothing is running.
	 *
	 * Anyone about to take the hand's transport away — `DebuggerManager.detach` — must await this
	 * after `cancel()`/`disarm()`: the abort needs several microtask hops to reach the release, and
	 * a detach that overtakes it leaves the page with a held mouse button and a piece stuck to the
	 * cursor. A cancelled run can hand over to a parked replacement, so this loops until the
	 * executor really is idle.
	 */
	async whenIdle(): Promise<void> {
		while (this.running) await this.running.done.catch(() => null);
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

	/**
	 * The scheduled move, or a replacement parked behind a cancelled run. A parked
	 * move is reported with `fireAt: now()` — `fireAt <= now` means "due now", it
	 * carries no `timing`/`ctx` of its own — and stays reported until it starts
	 * (`isRunning()`) or is dropped (`cancel()` / `disarm()` / `dispose()` / a newer
	 * `schedule()`), in which case an `aborted: "dropped"` event follows.
	 */
	pendingMove(): { rec: Recommendation; fireAt: number } | null {
		if (this.pending) return { rec: this.pending.rec, fireAt: this.pending.fireAt };
		if (this.parked) return { rec: this.parked.rec, fireAt: this.now() };
		return null;
	}

	isRunning(): boolean {
		return this.running !== null;
	}

	/**
	 * The move the hand is working through right now and the plan it is running —
	 * which is what the panel's countdown reads once the move has left `pendingMove()`
	 * (a plan whose deadline is `now + thinkMs` is never parked: the hand owns the
	 * whole window).
	 */
	runningMove(): { rec: Recommendation; plan: TimingPlan } | null {
		const running = this.running;
		return running ? { rec: running.rec, plan: running.timing } : null;
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

	/**
	 * Run the hand so the move completes at `plan.deadlineMs`. Replaces any pending
	 * move, including a replacement parked behind a cancelled run (newest wins).
	 */
	schedule(rec: Recommendation, plan: TimingPlan, ctx: MoveContext = {}): void {
		if (this.disposed) return;
		this.clearPending();
		this.parked?.ac.abort();
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

	/**
	 * Drop the pending move and any parked replacement; abort a running one (the
	 * hand releases at once) and the board check in flight, if any.
	 */
	cancel(): void {
		this.clearPending();
		this.parked?.ac.abort();
		this.running?.ac.abort();
		this.checkAc?.abort();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel();
		this.listeners.clear();
	}

	// ── execution ─────────────────────────────────────────────────────────

	/**
	 * One execution at a time per tab. After `cancel()` the running execution
	 * winds down within one bounded board re-check (release, then a fresh
	 * `EXECUTOR.recheckTimeoutMs` check that only a further cancel aborts); a
	 * replacement request is *parked* behind it — visible to `pendingMove()`,
	 * dropped by `cancel()` / `disarm()` / `dispose()` / a newer `schedule()` —
	 * and plays only if the hand is still armed and the run it waited on did
	 * *not* land its move (an `executed` outcome, including an interrupted press
	 * the re-check confirmed, ends the replacement as `skipped: position-changed`
	 * — never a second piece after our move is on the board, §9.3), after its
	 * own position guard (`dispatch`). A second
	 * request while an execution is live (not cancelled) is dropped and the
	 * running promise returned: the session owns the "one recommendation per
	 * position" rule and must `cancel()` before scheduling a replacement —
	 * queueing here would play a stale move. (Queued for Task 30: decide whether
	 * a newer recommendation should abort the running one instead.)
	 */
	private async execute(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext
	): Promise<ExecutionResult> {
		let replacement = false;
		if (this.running) {
			if (!this.running.ac.signal.aborted) {
				log.warn("executor: execution already running; request dropped (cancel() first)", {
					tabId: this.tabId,
					uci: rec.chosen.uci,
				});
				return this.running.done;
			}
			const park = { rec, ac: new AbortController() };
			this.parked?.ac.abort();
			this.parked = park;
			let landed = false;
			while (this.running && !park.ac.signal.aborted) {
				const prior = await this.running.done.catch(() => null);
				landed = prior?.ok === true && prior.outcome === "executed";
			}
			if (this.parked === park) this.parked = null;
			replacement = true;
			if (park.ac.signal.aborted || this.disposed || !this.isArmed()) {
				return this.droppedReplacement(rec);
			}
			if (landed) return this.landedReplacement(rec);
		}
		if (this.disposed) return this.droppedReplacement(rec);
		const ac = new AbortController();
		const done = this.runOne(rec, timing, ctx, ac.signal, replacement);
		this.running = { rec, timing, ac, done };
		try {
			return await done;
		} finally {
			this.running = null;
		}
	}

	/** A parked replacement that `cancel()` / `disarm()` / `dispose()` dropped: reported, never dispatched. */
	private droppedReplacement(rec: Recommendation): ExecutionResult {
		log.info("executor: parked replacement dropped", {
			tabId: this.tabId,
			uci: rec.chosen.uci,
			armed: this.isArmed(),
			disposed: this.disposed,
		});
		const result = this.stamp(rec, {
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.dropped,
			tier: this.dominantStyle,
			attempts: 0,
			endPoint: this.ownership.position(this.tabId) ?? { x: 0, y: 0 },
			elapsedMs: 0,
			timeline: [],
		});
		if (!this.disposed) this.emit("aborted", { rec, result });
		return result;
	}

	/** The run a replacement waited on landed its move: the position moved on, nothing is dispatched. */
	private landedReplacement(rec: Recommendation): ExecutionResult {
		log.info("executor: interrupted move landed; parked replacement not dispatched", {
			tabId: this.tabId,
			uci: rec.chosen.uci,
		});
		const result = this.stamp(rec, this.skipped(EXECUTOR.reasons.positionChanged, 0));
		this.emit("skipped", { rec, result });
		return result;
	}

	/**
	 * Every result the executor emits carries the move it belongs to (`san`, Task 26's
	 * Last-action row) and the moment it finished (`at`, which Task 24 keys the played flash on).
	 */
	private stamp(rec: Recommendation, result: ExecutionResult): ExecutionResult {
		return { ...result, at: this.now(), san: rec.chosen.san };
	}

	private skipped(reason: string, elapsedMs: number): ExecutionResult {
		return {
			ok: false,
			outcome: "skipped",
			reason,
			tier: this.dominantStyle,
			attempts: 0,
			endPoint: this.ownership.position(this.tabId) ?? { x: 0, y: 0 },
			elapsedMs,
			timeline: [],
		};
	}

	private async runOne(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		signal: AbortSignal,
		replacement: boolean
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
			await this.settleAfterAttach(signal);
			if (!this.debugger.isAttached(this.tabId)) {
				log.warn("executor: debugger not attached at execution time (arm first)", {
					tabId: this.tabId,
					lastError: this.debugger.lastError(this.tabId) ?? null,
				});
				result = fail(EXECUTOR.reasons.notAttached);
			} else {
				const reply = await this.readGeometry(this.tabId, undefined, signal);
				if (reply) result = await this.dispatch(rec, timing, ctx, reply, signal, replacement);
				else if (signal.aborted) {
					// cancel() during the initial geometry read: nothing was dispatched
					result = { ...fail(EXECUTOR.reasons.aborted), outcome: "aborted" };
				} else result = fail(EXECUTOR.reasons.noGeometry);
			}
		} catch (error) {
			result = fail(EXECUTOR.reasons.dispatchFailed, errorMessage(error));
		}
		this.setHand("rest");
		this.lastSkipReason = result.outcome === "skipped" ? (result.reason ?? null) : null;
		result = this.stamp(rec, result);
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
		signal: AbortSignal,
		replacement: boolean
	): Promise<ExecutionResult> {
		const readAt = this.now();
		const expected: ExpectedMove = { from: rec.chosen.from, to: rec.chosen.to };
		if (rec.chosen.promotion) expected.promotion = rec.chosen.promotion;
		// Position guard: never dispatch on a position that already changed (a replacement after a
		// cancelled run, or any reply whose occupancy says the piece left the from-square).
		const guard = await this.positionChanged(rec, reply, replacement);
		if (guard !== null) {
			log.info("executor: position guard vetoed the committed press; not dispatching", {
				tabId: this.tabId,
				uci: rec.chosen.uci,
				...guard,
			});
			return { ...this.skipped(guard.reason, this.now() - readAt), outcome: guard.outcome };
		}
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
			...(this.board ? { board: this.board } : {}),
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
		const check = (timeoutMs: number, checkSignal: AbortSignal): Promise<VerifyResult> =>
			this.config.verifyMoves
				? verifyMove(this.link, this.tabId, expected, timeoutMs, checkSignal)
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
				verify: check,
				recheck: (checkSignal) => check(EXECUTOR.recheckTimeoutMs, checkSignal),
				checkSignal: () => this.freshCheckSignal(),
				delay: (ms) => sleep(ms, this.scheduler, signal),
				verifyTimeoutMs: TIMINGS.executorVerifyTimeoutMs,
				signal,
			});
		} finally {
			this.checkAc = null;
			backend.dispose();
		}
	}

	/**
	 * §13.4: arming attaches the debugger, Chrome shows its "is debugging this browser" infobar and
	 * the page reflows — which moves and resizes the board. The spec's intent is that arming happens
	 * in the waiting view, before a game, precisely so that shift lands outside every move window;
	 * arming mid-game is allowed, so the first execution after an attach waits for the board's rect
	 * to have been unchanged for `EXECUTOR.attachSettleStableMs` before reading geometry.
	 *
	 * Evidence-driven and bounded: with no reported movement there is nothing to settle and the wait
	 * is zero, and a page that never stops moving is given up on after
	 * `EXECUTOR.attachSettleMaxMs` (the hand's own reflow guard covers what is left).
	 */
	private async settleAfterAttach(signal: AbortSignal): Promise<void> {
		const since = this.attachedAt;
		this.attachedAt = null;
		const board = this.board;
		if (since === null || !board) return;
		const giveUpAt = since + EXECUTOR.attachSettleMaxMs;
		let waited = 0;
		while (this.now() < giveUpAt && !signal.aborted) {
			const changedAt = board.changedAt(this.tabId);
			if (changedAt === null || this.now() - changedAt >= EXECUTOR.attachSettleStableMs) break;
			const step = Math.min(
				EXECUTOR.attachSettlePollMs,
				Math.max(1, giveUpAt - this.now()),
				Math.max(1, changedAt + EXECUTOR.attachSettleStableMs - this.now())
			);
			await sleep(step, this.scheduler, signal);
			waited += step;
		}
		if (waited > 0)
			log.debug("executor: waited for the layout to settle after the attach", {
				tabId: this.tabId,
				waitedMs: waited,
			});
	}

	/** A board-check signal that only a cancel arriving from now on aborts. */
	private freshCheckSignal(): AbortSignal {
		this.checkAc = new AbortController();
		return this.checkAc.signal;
	}

	/**
	 * `null` when our piece is still on `from` (and `to` is not ours); otherwise the
	 * verdict. Occupancy from the reply answers for free; a replacement without it
	 * asks the adapter the colour-aware `boardCheck` question (bounded, fresh
	 * signal) — never `observeMove`, whose "piece on the destination" answer would
	 * veto a capture. An unanswerable check counts as changed (nothing is
	 * dispatched on a guess); a check cut short by `cancel()` is `aborted`.
	 */
	private async positionChanged(
		rec: Recommendation,
		reply: BoardGeometryReply,
		replacement: boolean
	): Promise<{ outcome: "skipped" | "aborted"; reason: string } | null> {
		const changed = { outcome: "skipped", reason: EXECUTOR.reasons.positionChanged } as const;
		if (reply.occupancy) {
			return positionIntact(reply, rec.chosen.from, rec.chosen.to) ? null : changed;
		}
		if (!replacement || !this.config.verifyMoves) return null;
		const { from, to } = rec.chosen;
		const signal = this.freshCheckSignal();
		const seen = await checkSquares(
			this.link,
			this.tabId,
			[from, to],
			EXECUTOR.recheckTimeoutMs,
			signal
		);
		this.checkAc = null;
		if (seen.outcome === "unavailable") {
			return signal.aborted
				? { outcome: "aborted", reason: EXECUTOR.reasons.aborted }
				: { outcome: "skipped", reason: EXECUTOR.reasons.verificationUnavailable };
		}
		const occ = seen.occupancy;
		if (occ[from] === undefined || occ[to] === undefined) {
			// A square the adapter could not classify: nothing is dispatched on a guess.
			return { outcome: "skipped", reason: EXECUTOR.reasons.verificationUnavailable };
		}
		return occ[from] === "own" && occ[to] !== "own" ? null : changed;
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
		promotion?: { piece: PromoPiece; to: Square },
		signal?: AbortSignal
	): Promise<BoardGeometryReply | null> {
		try {
			const cmd: RequestInput<"geometry"> = promotion
				? {
						kind: "geometry",
						promotion: promotion.piece,
						to: promotion.to,
						timeoutMs: EXECUTOR.promotionPickerTimeoutMs,
					}
				: { kind: "geometry" };
			const budget = promotion
				? EXECUTOR.promotionPickerTimeoutMs + EXECUTOR.geometryTimeoutMs
				: EXECUTOR.geometryTimeoutMs;
			const { kind: _kind, id: _id, ...reply } = await this.link.request(tabId, cmd, budget, signal);
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
