import type { PreparedPointer } from "@core/constants/cdp";
/**
 * `MoveExecutor` (§9.3, Appendix G §7.5): the per-tab façade the `GameSession`
 * (Task 30) drives. `arm()` attaches the debugger (arm time, waiting view —
 * never mid-game, §13.4) and hands the pointer to the virtual hand (§13.5);
 * `schedule(rec, plan)` runs the hand so the drop lands on `plan.deadlineMs`
 * (the pre-touch window shrinks when the engine already used part of the
 * think time; a plan whose deadline is far off waits on the injected
 * scheduler); `playNow()` executes the pending move with an instant plan;
 * `cancel()` aborts (a held piece is dropped at once). Every execution is
 * verified through the content adapter and retried once (`retry-policy.ts`); the outcome is emitted as `executed | failed |
 * aborted | skipped`, hand-state changes as `hand`. Every committed move is a
 * drag (click-to-move was removed end to end), so the retry is a second drag.
 */

import { isSquare } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply, ExpectedMove } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { FAST_TOUCH, OPPONENT_EXPLORATION } from "@core/motor/constants";
import { sampleRange } from "@core/motor/geometry";
import {
	perGameProfile,
	perMoveProfile,
	profileFor,
	withMotorSpeed,
} from "@core/motor/motor-profile";
import type { OpponentExplorationCandidates } from "@core/motor/opponent-candidates";
import { planOpponentExploration } from "@core/motor/opponent-exploration";
import { plausibleStart } from "@core/motor/sampling";
import type {
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
import {
	defaultNow,
	defaultScheduler,
	isAbortedError,
	type Scheduler,
	sleep,
} from "@core/util/scheduler";
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
	fastTouch,
	type GeometryProvider,
	HandController,
	positionIntact,
	preTouchMsOf,
	type TimingWindow,
} from "./hand-controller";
import { runWithRetry } from "./retry-policy";
import { checkSquares, type VerifyResult, verifyMove } from "./verifier";

/** The slice of `ContentLink` the executor needs (geometry + verification requests). */
export interface ExecutorLink {
	confirmPointer?(tabId: number, pointer: PreparedPointer): Promise<boolean>;
	preparePointer?(
		tabId: number,
		pointer: PreparedPointer,
		signal?: AbortSignal
	): Promise<number | undefined>;
	request<K extends RequestKind>(
		tabId: number,
		cmd: RequestInput<K>,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<ReplyFor<K>>;
}

export interface ExecutorGameConfig {
	persona: PersonaId;
	motorSpeed?: number;
	tcClass: TimeControlClass;
	/** `Settings.execution.previewSelectScale`, 0 when previews are off. */
	previewScale: number;
	/** Seeds the per-game hand (profile offsets, per-move sampling). */
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
	/**
	 * Fix F: this move is being **sent as a premove**, during the opponent's turn. Three things
	 * change. The position guard stops asking whether the destination is free of our own pieces —
	 * a recapture premove is aimed at the very piece the opponent is about to take. Verification is
	 * not attempted at all: a premove does not land until the opponent moves, so `observeMove` would
	 * time out and the retry policy would send the move a second time. And the outcome is
	 * `dispatched`, never `executed`: nothing has been played, and nothing here can even tell
	 * whether the site kept the gesture.
	 */
	queuedPremove?: boolean;
}

export interface ExecutionReport {
	rec: Recommendation;
	result: ExecutionResult;
}

export interface ExecutorEvents {
	executed: ExecutionReport;
	/** Fix F: a premove gesture the hand completed during the opponent's turn (`MoveContext`). */
	dispatched: ExecutionReport;
	failed: ExecutionReport;
	aborted: ExecutionReport;
	skipped: ExecutionReport;
	hand: HandState;
	/**
	 * Fix D: one event per point the renderer has *acknowledged* — the tap the page-side pointer
	 * mirror is fed from, so what the owner sees is what the page was told rather than a plan.
	 * Viewport CSS px (the space `Input.dispatchMouseEvent` takes), rounded as dispatched, with
	 * the left-button state that command carried. The rate is the hand's own: 33-53 points/s over a
	 * move, gap p50 ~7 ms and p90 ~33 ms, with the long tail being its deliberate pauses
	 * (`GameSession.onHandPointer` carries the full measurement and why nothing is coalesced).
	 */
	pointer: { x: number; y: number; pressed: boolean };
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
	ctx: MoveContext;
	/** The committed mouse-down has entered dispatch, including its acknowledgement wait. */
	committed: boolean;
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
	const urgent = fastTouch(plan);
	const floor = urgent ? fastFloor(plan) : EXECUTOR.minExecutionMs;
	const natural = Math.max(floor, plan.window.approachMs);
	const thinkMs = urgent && plan.thinkMs > 0 ? Math.min(plan.thinkMs, natural) : natural;
	return {
		...withPreTouch(plan, 0),
		mode: plan.mode === "premove" ? "premove" : "instant",
		thinkMs,
		window: {
			orientationMs: 0,
			scanMs: 0,
			previewMs: 0,
			decisionMs: 0,
			approachMs: thinkMs,
		},
	};
}

/**
 * The plan the hand runs when only `availableMs` remain until the deadline:
 * the touch budget is kept and the pre-touch window absorbs the loss.
 */
export function fitTiming(plan: TimingPlan, availableMs: number): TimingPlan {
	if (availableMs >= plan.thinkMs) return plan;
	const thinkMs = Math.max(fastTouch(plan) ? fastFloor(plan) : EXECUTOR.minExecutionMs, availableMs);
	const touchBudget = Math.min(plan.window.approachMs, thinkMs);
	const preTouch = Math.max(0, Math.min(preTouchMsOf(plan), thinkMs - touchBudget));
	const fitted = withPreTouch(plan, preTouch);
	return {
		...fitted,
		thinkMs,
		dragDurationMs: Math.min(plan.dragDurationMs, touchBudget),
		window: { ...fitted.window, approachMs: thinkMs - preTouch },
	};
}

/** Transport delay may shorten an urgent plan, never inflate it to a repeated execution floor. */
function fastFloor(plan: TimingPlan): number {
	return Math.min(FAST_TOUCH.minBudgetMs, plan.thinkMs > 0 ? plan.thinkMs : FAST_TOUCH.minBudgetMs);
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
	private readonly geometry: GeometryProvider;
	private readonly listeners = new Map<ExecutorEvent, Set<(payload: never) => void>>();
	private pending: Pending | null = null;
	private running: Running | null = null;
	private fastForward: {
		rec: Recommendation;
		version: number;
		done: Promise<ExecutionResult | null>;
	} | null = null;
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
	private armVersion = 0;
	private focusReservation: number | null = null;
	private inputVersion = 0;
	private exploration: { ac: AbortController; done: Promise<void> } | null = null;
	private explorationSeed = 0;
	private waitingForExploration = 0;

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
			motorSpeed: deps.motorSpeed ?? 1,
			tcClass: deps.tcClass,
			previewScale: deps.previewScale,
			gameSeed: deps.gameSeed,
			verifyMoves: deps.verifyMoves ?? true,
		};
		this.geometry = {
			read: (tabId, promotion, signal) => this.readGeometry(tabId, promotion, signal),
		};
	}

	/** The hand's motor time-control class (Appendix G §8). */
	timeControlClass(): TimeControlClass {
		return this.config.tcClass;
	}

	/**
	 * §4.6 / §4.3: the time control arrived after the game started, so the hand's class changes
	 * **in place**. Replacing the executor instead would dispose an armed hand and re-arm it, and
	 * a re-arm means `chrome.debugger.attach` — Chrome's infobar, a page reflow and a board that
	 * moves, mid-game, which is exactly what §13.4 arms in the waiting view to avoid. The class is
	 * read at the start of every execution (`profileFor`), so the next move uses the new profile
	 * and nothing in flight changes shape underneath itself.
	 */
	setTimeControlClass(tcClass: TimeControlClass): void {
		if (this.config.tcClass === tcClass) return;
		log.info("executor: motor time-control class changed", {
			tabId: this.tabId,
			from: this.config.tcClass,
			to: tcClass,
		});
		this.config.tcClass = tcClass;
	}

	/** Next executions/bouts use live controls; a committed gesture keeps its sampled profile. */
	updateSettings(
		settings: Pick<ExecutorGameConfig, "persona" | "previewScale" | "verifyMoves" | "motorSpeed">
	): void {
		Object.assign(this.config, settings);
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	/**
	 * Arm-time work (waiting view, §13.4): attach the debugger now so the
	 * infobar lands outside any move window, and transfer the pointer to the
	 * hand from the last real position / previous rest point.
	 */
	async arm(startPoint?: Pt): Promise<void> {
		if (this.disposed) return;
		const version = ++this.armVersion;
		const reservation = this.debugger.reserveFocus(this.tabId);
		this.focusReservation = reservation;
		const wasAttached = this.debugger.isAttached(this.tabId);
		try {
			await this.debugger.ensureAttached(this.tabId);
			if (this.disposed || version !== this.armVersion) return;
			await this.debugger.setFocusMaintained(this.tabId, true, reservation);
		} catch (error) {
			if (version === this.armVersion && this.debugger.hasFocusReservation(this.tabId, reservation)) {
				this.cancel();
				this.ownership.released(this.tabId);
				await this.whenIdle();
			}
			await this.debugger
				.setFocusMaintained(this.tabId, false, reservation)
				.catch((restoreError: unknown) =>
					log.warn("executor: focus restoration after failed arm failed", restoreError)
				);
			throw error;
		}
		if (
			this.disposed ||
			version !== this.armVersion ||
			!this.debugger.hasFocusReservation(this.tabId, reservation)
		)
			return;
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
		this.armVersion += 1;
		const reservation = this.focusReservation;
		this.cancel();
		this.ownership.released(this.tabId);
		void this.whenIdle()
			.then(async () => {
				if (reservation !== null && !this.ownership.isArmed(this.tabId))
					await this.debugger.setFocusMaintained(this.tabId, false, reservation);
			})
			.catch((error: unknown) => log.warn("executor: focus restoration failed", error));
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
		while (this.running || this.exploration) {
			await Promise.all([this.running?.done.catch(() => null), this.exploration?.done]);
		}
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

	/** Hovering, previews, decision pauses and approach remain interruptible until mouse-down. */
	canFastForward(): boolean {
		return this.running?.committed !== true;
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

	/** Start cancellable free movement; the live source also supplies the position/turn gate. */
	exploreOpponent(source: () => OpponentExplorationCandidates | null): void {
		if (this.disposed || !this.isArmed()) return;
		const previous = this.exploration;
		if (previous && !previous.ac.signal.aborted) return;
		const ac = new AbortController();
		const task = { ac, done: Promise.resolve() };
		this.exploration = task;
		task.done = Promise.resolve()
			.then(async () => {
				if (previous) await previous.done;
				// A completed premove reports before its execution promise settles. Let its last
				// stationary rest/release finish, then resume from the actual hand endpoint.
				while (this.running && !ac.signal.aborted) await this.running.done.catch(() => null);
				if (
					ac.signal.aborted ||
					this.pending ||
					this.waitingForExploration > 0 ||
					this.disposed ||
					!this.isArmed()
				)
					return;
				await this.settleAfterAttach(ac.signal);
				const rng = createRng(`${this.config.gameSeed}:opponent:${this.explorationSeed++}`);
				const initial = source();
				if (!initial) return;
				await sleep(
					sampleRange(
						initial.policy?.lowTime
							? OPPONENT_EXPLORATION.lowTimeInitialRestMs
							: OPPONENT_EXPLORATION.initialRestMs,
						rng
					),
					this.scheduler,
					ac.signal
				);
				let previousTarget: Square | undefined;
				while (!ac.signal.aborted && !this.disposed && this.isArmed() && !this.pending) {
					if (!source()) return;
					const reply = await this.readGeometry(this.tabId, undefined, ac.signal);
					const candidates = source();
					if (!reply || ac.signal.aborted || !candidates) return;
					const geometry = boardGeometryOf(reply);
					const cursor = this.ownership.position(this.tabId) ?? plausibleStart(geometry.boardRect, rng);
					const profile = withMotorSpeed(
						perMoveProfile(
							perGameProfile(
								profileFor(this.config.persona, this.config.tcClass, "normal"),
								createRng(`${this.config.gameSeed}:hand`)
							),
							rng
						),
						this.config.motorSpeed
					);
					const plan = planOpponentExploration(
						{
							geometry,
							profile,
							cursor,
							...candidates,
							...(previousTarget ? { previousTarget } : {}),
						},
						rng
					);
					const controller = new HandController({
						backend: this.createBackend(cursor),
						focus: this.focus,
						ownership: this.ownership,
						geometry: this.geometry,
						...(this.board ? { board: this.board } : {}),
						rng,
						now: this.now,
						scheduler: this.scheduler,
						// No execution hand event: a position transition can arrive during any await.
					});
					const lowTime = candidates.policy?.lowTime === true;
					const ownOnly = lowTime || candidates.policy?.ownOnly === true;
					try {
						await controller.explore(this.tabId, plan.actions, ac.signal, geometry.boardRect, () => {
							const live = source();
							return (
								live !== null && (!live.policy?.lowTime || lowTime) && (!live.policy?.ownOnly || ownOnly)
							);
						});
					} catch (error) {
						// Tightening clock/tactical policy ends the old bout before its next point.
						// Parent cancellation still exits the outer loop and retains the current endpoint.
						if (isAbortedError(error) && !ac.signal.aborted) continue;
						throw error;
					}
					previousTarget = plan.lastTarget ?? undefined;
				}
			})
			.catch((error: unknown) => {
				if (!ac.signal.aborted)
					log.debug("executor: opponent exploration ended", { error: errorMessage(error) });
			})
			.finally(() => {
				if (this.exploration === task) this.exploration = null;
			});
	}

	isExploring(): boolean {
		return this.exploration !== null && !this.exploration.ac.signal.aborted;
	}

	// ── scheduling ────────────────────────────────────────────────────────

	/**
	 * Run the hand so the move completes at `plan.deadlineMs`. Replaces any pending
	 * move, including a replacement parked behind a cancelled run (newest wins).
	 */
	schedule(rec: Recommendation, plan: TimingPlan, ctx: MoveContext = {}): void {
		if (this.disposed) return;
		this.clearPending();
		this.exploration?.ac.abort();
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
	playNow(
		rec?: Recommendation,
		plan?: TimingPlan,
		ctx?: MoveContext
	): Promise<ExecutionResult | null> {
		const pending = this.pending;
		const running = this.running;
		this.clearPending();
		const target = rec ?? pending?.rec ?? running?.rec;
		const base = plan ?? pending?.timing ?? running?.timing;
		if (!target || !base) return Promise.resolve(null);
		const forwarding = this.fastForward;
		if (
			forwarding &&
			forwarding.version === this.inputVersion &&
			forwarding.rec.fen === target.fen &&
			forwarding.rec.chosen.uci === target.chosen.uci
		)
			return forwarding.done;
		if (running && !running.ac.signal.aborted) {
			// Preparation includes the approach and pre-grab pause. After the admitted mouse-down,
			// a shortcut must never abort the held piece or re-enter the move during verification.
			if (running.committed) return running.done;
			running.ac.abort();
		}
		const instant = instantTiming(base);
		instant.deadlineMs = this.now() + instant.thinkMs;
		const done = this.execute(target, instant, ctx ?? pending?.ctx ?? running?.ctx ?? {}).finally(
			() => {
				if (this.fastForward?.done === done) this.fastForward = null;
			}
		);
		this.fastForward = { rec: target, version: this.inputVersion, done };
		return done;
	}

	/**
	 * Drop the pending move and any parked replacement; abort a running one (the
	 * hand releases at once) and the board check in flight, if any.
	 */
	cancel(): void {
		this.inputVersion += 1;
		this.exploration?.ac.abort();
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
		const version = this.inputVersion;
		const exploration = this.exploration;
		if (exploration) {
			exploration.ac.abort();
			this.waitingForExploration += 1;
			try {
				await exploration.done;
			} finally {
				this.waitingForExploration -= 1;
			}
			if (version !== this.inputVersion || this.disposed || !this.isArmed())
				return this.droppedReplacement(rec);
		}
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
		this.running = { rec, timing, ctx, committed: false, ac, done };
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
			tier: EXECUTOR.committedTier,
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
			tier: EXECUTOR.committedTier,
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
				tier: EXECUTOR.committedTier,
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
				: result.outcome === "dispatched"
					? "dispatched"
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
		const config = { ...this.config };
		const readAt = this.now();
		const expected: ExpectedMove = {
			from: rec.chosen.from,
			to: rec.chosen.to,
			beforeFen: rec.fen,
		};
		if (rec.chosen.promotion) expected.promotion = rec.chosen.promotion;
		// Fix F: a premove sent during the opponent's turn (`MoveContext.queuedPremove`).
		const queued = ctx.queuedPremove === true;
		// Position guard: never dispatch on a position that already changed (a replacement after a
		// cancelled run, or any reply whose occupancy says the piece left the from-square).
		const guard = await this.positionChanged(rec, reply, replacement, queued);
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
		const moveRng = createRng(`${config.gameSeed}:${rec.fen}:${rec.chosen.uci}`);
		// A premove MUST be a drag, and since click-to-move was removed every committed move is
		// one, so there is nothing to choose here any more. Keeping the reason on the record: a
		// click-click premove would press the destination square as a second selection, and a
		// premove's destination is routinely one of our own pieces (a recapture), so the site
		// would read that press as "select that piece instead" and leave a selection standing,
		// which §13.7 item 3 forbids outright. The drag is also the gesture the site's premove UI
		// is built around.
		const moveKind = ctx.moveKind ?? this.moveKindOf(rec);
		const motor = perMoveProfile(
			perGameProfile(
				profileFor(config.persona, config.tcClass, moveKind),
				createRng(`${config.gameSeed}:hand`)
			),
			moveRng
		);
		const start =
			this.ownership.position(this.tabId) ?? plausibleStart(geo.boardRect, moveRng, fromRect);
		this.ownership.setPosition(this.tabId, start);
		const backend = this.createBackend(start);
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
			onCommittedPress: () => {
				const running = this.running;
				if (!running || running.ac.signal !== signal || running.committed) return;
				running.committed = true;
				// The hand was already `grabbing` during the pre-grab pause. Publish the exact
				// availability boundary even though its display phase has not changed.
				this.emit("hand", this.hand);
			},
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
			motor,
			motorSpeed: config.motorSpeed ?? 1,
			// `premove` here means "entered as a premove", which is what relaxes the hand's own
			// destination guard — not merely "the §7.4 policy chose it" (a premove played after the
			// predicted reply landed is an ordinary move and is guarded like one).
			expected: { san: rec.chosen.san, uci: rec.chosen.uci, premove: queued },
			geometry: { reply, readAt },
			exploration: {
				candidates: ctx.candidates ?? candidatesFromLines(rec),
				nReasonable: ctx.nReasonable ?? Math.max(1, rec.lines.length),
				myClockMs: ctx.myClockMs ?? 0,
				persona: config.persona,
				previewScale: config.previewScale,
				legalDestinations: ctx.legalDestinations ?? (() => []),
			},
		};
		if (rec.chosen.promotion) plan.promotion = rec.chosen.promotion;
		// Optional normal verification never disables the evidence check after a failed
		// or interrupted press: even a preview release might have submitted a move.
		const check = (timeoutMs: number, checkSignal: AbortSignal): Promise<VerifyResult> =>
			verifyMove(this.link, this.tabId, expected, timeoutMs, checkSignal);
		try {
			// Setup and replacement verification consume the original move window too.
			const readyTiming = fitTiming(timing, timing.deadlineMs - this.now());
			if (this.running?.rec === rec) this.running.timing = readyTiming;
			if (queued) return await this.enterPremove(controller, plan, readyTiming, signal);
			return await runWithRetry({
				attempt: (index) =>
					controller.execute(plan, index === 0 ? readyTiming : instantTiming(readyTiming), signal),
				verify: (timeoutMs, checkSignal) =>
					config.verifyMoves ? check(timeoutMs, checkSignal) : Promise.resolve({ outcome: "ok" }),
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
	 * Fix F: enter a premove and stop. One attempt, because a retry would hand the site the move a
	 * second time, and **no verification**, because a premove is not on the board yet —
	 * `observeMove` would watch the destination until its budget ran out and the retry policy would
	 * read that timeout as "not submitted".
	 *
	 * The report is therefore `dispatched`, and that is the strongest thing that can honestly be
	 * said here: the drag went out. Whether chess.com kept it, snapped the piece back, or read the
	 * drop as a selection is **not observable** — the site exposes no premove state this extension
	 * can read (see the lane report) — so nothing in this file may claim acceptance. The next
	 * position decides (`GameSession.reconcilePremove`), which is what keeps a silently dropped
	 * premove from ever being reported as played. Anything but a completed drag passes through as
	 * its own outcome: a drag the hand did not finish is not a gesture the site saw.
	 */
	private async enterPremove(
		controller: HandController,
		plan: ExecutionPlan,
		timing: TimingPlan,
		signal: AbortSignal
	): Promise<ExecutionResult> {
		const result = await controller.execute(plan, timing, signal);
		if (!result.ok) return result;
		log.info("executor: premove gesture dispatched; acceptance by the site is unconfirmed", {
			tabId: this.tabId,
			uci: plan.expected.uci,
		});
		return { ...result, outcome: "dispatched" };
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
		const board = this.board;
		if (since === null) return;
		if (!board) {
			this.attachedAt = null;
			return;
		}
		const giveUpAt = since + EXECUTOR.attachSettleMaxMs;
		let waited = 0;
		while (this.now() < giveUpAt) {
			// A cancelled execution never ran, so it must not consume the settle: `attachedAt` is
			// cleared only once a wait has actually finished, and the next execution waits instead.
			if (signal.aborted) return;
			const changedAt = board.changedAt(this.tabId);
			if (changedAt === null || this.now() - changedAt >= EXECUTOR.attachSettleStableMs) break;
			const step = Math.min(
				EXECUTOR.attachSettlePollMs,
				Math.max(1, giveUpAt - this.now()),
				Math.max(1, changedAt + EXECUTOR.attachSettleStableMs - this.now())
			);
			try {
				await sleep(step, this.scheduler, signal);
			} catch (error) {
				if (isAbortedError(error)) return;
				throw error;
			}
			waited += step;
		}
		this.attachedAt = null;
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
		replacement: boolean,
		queued = false
	): Promise<{ outcome: "skipped" | "aborted"; reason: string } | null> {
		const changed = { outcome: "skipped", reason: EXECUTOR.reasons.positionChanged } as const;
		// Fix F: a premove is entered in the position *before* the opponent's reply, where its
		// destination is routinely still ours — a recapture is aimed at the piece they are about to
		// take. Only "our piece is still on the from-square" is asked of it; "the destination is not
		// ours" is a rule about a move being legal now, which a premove is not.
		const to = queued ? undefined : rec.chosen.to;
		if (reply.occupancy) {
			return positionIntact(reply, rec.chosen.from, to) ? null : changed;
		}
		if (!replacement || !this.config.verifyMoves) return null;
		const from = rec.chosen.from;
		const squares: Square[] = to === undefined ? [from] : [from, to];
		const signal = this.freshCheckSignal();
		const seen = await checkSquares(
			this.link,
			this.tabId,
			squares,
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
		if (squares.some((sq) => occ[sq] === undefined)) {
			// A square the adapter could not classify: nothing is dispatched on a guess.
			return { outcome: "skipped", reason: EXECUTOR.reasons.verificationUnavailable };
		}
		return occ[from] === "own" && (to === undefined || occ[to] !== "own") ? null : changed;
	}

	private moveKindOf(rec: Recommendation): MotorMoveKind {
		if (rec.chosen.promotion) return "promotion";
		if (rec.chosen.source === "premove") return "premove";
		return "normal";
	}

	private createBackend(start: Pt): CdpInputBackend {
		return CdpInputBackend.forTab(this.debugger, this.tabId, start, {
			now: this.now,
			scheduler: this.scheduler,
			...(this.link.preparePointer
				? {
						beforeDispatch: (p: PreparedPointer, signal?: AbortSignal) =>
							this.link.preparePointer?.(this.tabId, p, signal) ?? Promise.resolve(undefined),
					}
				: {}),
			...(this.link.confirmPointer
				? {
						afterDispatch: (p: PreparedPointer) =>
							this.link.confirmPointer?.(this.tabId, p) ?? Promise.resolve(true),
					}
				: {}),
			onDispatch: (p) => this.emit("pointer", p),
		});
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
