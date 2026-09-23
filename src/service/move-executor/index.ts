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
 *
 * This file is the executor's public entry. Its parts live in `executor/`: the execution state
 * machine (`execution-slots.ts`), one move's dispatch to the hand (`dispatch.ts`, with
 * `move-plan.ts`, `scramble-hold.ts` and `line-previews.ts`), the board checks
 * (`board-checks.ts`), the post-attach settle (`attach-settle.ts`) and the idle hand during the
 * opponent's turn (`opponent-explorer.ts`).
 */

import { log } from "@core/logger";
import { ExplorationPlanner } from "@core/motor/exploration";
import type { LinePreviewMode } from "@core/motor/line-preview";
import type { OpponentExplorationCandidates } from "@core/motor/opponent-candidates";
import type { ExecutionResult, HandState, Pt, TimeControlClass } from "@core/motor/types";
import { defaultNow, defaultScheduler } from "@core/util/scheduler";
import type { GameSessionView, Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { AttachSettle } from "./executor/attach-settle";
import { BoardChecks } from "./executor/board-checks";
import type { ExecutorContext } from "./executor/context";
import { MoveDispatcher } from "./executor/dispatch";
import {
	type ExecutorEvent,
	type ExecutorEvents,
	ExecutorListeners,
	HAND_VIEW,
} from "./executor/events";
import { ExecutionSlots } from "./executor/execution-slots";
import { readBoardGeometry } from "./executor/geometry";
import { LinePreviewAllowance } from "./executor/line-previews";
import { OpponentExplorer } from "./executor/opponent-explorer";
import type { ExecutorGameConfig, MoveContext, MoveExecutorDeps } from "./executor/types";

export type { ExecutorEvent, ExecutorEvents } from "./executor/events";
export { candidatesFromLines } from "./executor/move-facts";
export { fitTiming, instantTiming } from "./executor/timing-fit";
export type {
	ExecutionReport,
	ExecutorGameConfig,
	ExecutorLink,
	MoveContext,
	MoveExecutorDeps,
} from "./executor/types";

export class MoveExecutor {
	private readonly tabId: number;
	private readonly ctx: ExecutorContext;
	private readonly listeners = new ExecutorListeners();
	private readonly settle: AttachSettle;
	private readonly explorer: OpponentExplorer;
	private readonly slots: ExecutionSlots;
	private readonly previews = new LinePreviewAllowance();
	private disposed = false;
	private armVersion = 0;
	private focusReservation: number | null = null;

	constructor(deps: MoveExecutorDeps) {
		this.tabId = deps.tabId;
		const link = deps.link;
		const board = deps.board ?? null;
		const now = deps.now ?? defaultNow;
		const scheduler = deps.scheduler ?? defaultScheduler;
		this.ctx = {
			tabId: deps.tabId,
			site: deps.site,
			debugger: deps.debugger,
			link,
			focus: deps.focus,
			ownership: deps.ownership,
			board,
			now,
			scheduler,
			config: {
				persona: deps.persona,
				motorSpeed: deps.motorSpeed ?? 1,
				tcClass: deps.tcClass,
				previewScale: deps.previewScale,
				gameSeed: deps.gameSeed,
				verifyMoves: deps.verifyMoves ?? true,
				inputMode: deps.inputMode ?? "drag",
				linePreview: deps.linePreview ?? "auto",
			},
			geometry: {
				read: (tabId, promotion, signal) => readBoardGeometry(link, tabId, promotion, signal),
			},
			emit: (event, payload) => this.emit(event, payload),
			isArmed: () => this.isArmed(),
			isDisposed: () => this.disposed,
		};
		this.settle = new AttachSettle(deps.tabId, board, now, scheduler);
		const checks = new BoardChecks(link, deps.tabId);
		this.explorer = new OpponentExplorer(this.ctx, this.settle, {
			running: () => this.slots.running(),
			hasPending: () => this.slots.hasPending(),
		});
		const dispatcher = new MoveDispatcher(
			this.ctx,
			{
				running: () => this.slots.running(),
				handState: () => this.slots.handState(),
				setHand: (s) => this.slots.setHand(s),
			},
			checks,
			this.previews,
			new ExplorationPlanner()
		);
		this.slots = new ExecutionSlots(this.ctx, this.settle, checks, this.explorer, dispatcher);
	}

	/** The hand's motor time-control class (Appendix G §8). */
	timeControlClass(): TimeControlClass {
		return this.ctx.config.tcClass;
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
		if (this.ctx.config.tcClass === tcClass) return;
		log.info("executor: motor time-control class changed", {
			tabId: this.tabId,
			from: this.ctx.config.tcClass,
			to: tcClass,
		});
		this.ctx.config.tcClass = tcClass;
	}

	/** Next executions/bouts use live controls; a committed gesture keeps its sampled profile. */
	updateSettings(
		settings: Pick<
			ExecutorGameConfig,
			"persona" | "previewScale" | "verifyMoves" | "motorSpeed" | "inputMode"
		> &
			Partial<Pick<ExecutorGameConfig, "linePreview">>
	): void {
		Object.assign(this.ctx.config, settings);
	}

	/** The line preview's mode for the next executions (`ExecutorGameConfig.linePreview`). */
	setLinePreviewMode(mode: LinePreviewMode): void {
		this.ctx.config.linePreview = mode;
	}

	/** Moves of this game that were given a line preview (`LINE_PREVIEW.maxPerGame` caps it). */
	linePreviewCount(): number {
		return this.previews.count();
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	/**
	 * Arm-time work (waiting view, §13.4): attach the debugger now so the
	 * infobar lands outside any move window, and transfer the pointer to the
	 * hand from the last real position / previous rest point.
	 */
	async arm(startPoint?: Pt): Promise<void> {
		if (this.disposed) return;
		const { debugger: dbg, ownership } = this.ctx;
		const version = ++this.armVersion;
		const reservation = dbg.reserveFocus(this.tabId);
		this.focusReservation = reservation;
		const wasAttached = dbg.isAttached(this.tabId);
		try {
			await dbg.ensureAttached(this.tabId);
			if (this.disposed || version !== this.armVersion) return;
			await dbg.setFocusMaintained(this.tabId, true, reservation);
		} catch (error) {
			if (version === this.armVersion && dbg.hasFocusReservation(this.tabId, reservation)) {
				this.cancel();
				ownership.released(this.tabId);
				await this.whenIdle();
			}
			await dbg
				.setFocusMaintained(this.tabId, false, reservation)
				.catch((restoreError: unknown) =>
					log.warn("executor: focus restoration after failed arm failed", restoreError)
				);
			throw error;
		}
		if (
			this.disposed ||
			version !== this.armVersion ||
			!dbg.hasFocusReservation(this.tabId, reservation)
		)
			return;
		// A *fresh* attach is the one that brings the infobar; re-arming an attached tab shifts nothing.
		if (!wasAttached) this.settle.attached(this.ctx.now());
		// While the mirror is on the page the arrow *is* the pointer the owner sees (the shield keeps
		// the real one off the page), so the hand resumes from the rest point it is parked on rather
		// than from a real pointer sample — what is shown and where the hand starts stay one point.
		const mirrored = this.ctx.link.pointerControlled?.(this.tabId) === true;
		ownership.armed(
			this.tabId,
			startPoint ??
				(mirrored ? ownership.position(this.tabId) : ownership.lastRealPosition(this.tabId)) ??
				undefined
		);
		log.info("executor: armed", { tabId: this.tabId, start: ownership.position(this.tabId) });
	}

	/** The user stopped the hand: cancel anything pending and give the pointer back. */
	disarm(): void {
		this.armVersion += 1;
		const reservation = this.focusReservation;
		this.cancel();
		this.ctx.ownership.released(this.tabId);
		void this.whenIdle()
			.then(async () => {
				if (reservation !== null && !this.ctx.ownership.isArmed(this.tabId))
					await this.ctx.debugger.setFocusMaintained(this.tabId, false, reservation);
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
		while (this.slots.running() || this.explorer.current()) {
			await Promise.all([this.slots.running()?.done.catch(() => null), this.explorer.current()?.done]);
		}
	}

	isArmed(): boolean {
		return this.ctx.ownership.isArmed(this.tabId) && this.ctx.debugger.isAttached(this.tabId);
	}

	handState(): HandState {
		return this.slots.handState();
	}

	/** The panel's hand pill (§9.7). */
	handView(): GameSessionView["hand"] {
		if (!this.ctx.debugger.isAttached(this.tabId)) return "detached";
		const hand = this.slots.handState();
		if (hand === "rest" && this.slots.lastSkip() !== null) return "paused";
		return HAND_VIEW[hand];
	}

	/**
	 * The scheduled move, or a replacement parked behind a cancelled run. A parked
	 * move is reported with `fireAt: now()` — `fireAt <= now` means "due now", it
	 * carries no `timing`/`ctx` of its own — and stays reported until it starts
	 * (`isRunning()`) or is dropped (`cancel()` / `disarm()` / `dispose()` / a newer
	 * `schedule()`), in which case an `aborted: "dropped"` event follows.
	 */
	pendingMove(): { rec: Recommendation; fireAt: number } | null {
		return this.slots.pendingMove();
	}

	isRunning(): boolean {
		return this.slots.running() !== null;
	}

	/** Changes on every explicit cancellation, including disarm/dispose and position replacement. */
	cancellationGeneration(): number {
		return this.slots.cancellationGeneration();
	}

	/** Hovering, previews, decision pauses and approach remain interruptible until mouse-down. */
	canFastForward(): boolean {
		return this.slots.canFastForward();
	}

	/** The move whose piece the hand is holding over its destination, waiting for the opponent. */
	holdingMove(): { rec: Recommendation } | null {
		return this.slots.holdingMove();
	}

	/** The opponent moved and the held move is still sound: let go — the move is played. */
	releaseHold(): boolean {
		return this.slots.decideHold("release");
	}

	/** The held move is no longer wanted: carry the piece back to its square and let go there. */
	abandonHold(): boolean {
		return this.slots.decideHold("abandon");
	}

	/**
	 * The move the hand is working through right now and the plan it is running —
	 * which is what the panel's countdown reads once the move has left `pendingMove()`
	 * (a plan whose deadline is `now + thinkMs` is never parked: the hand owns the
	 * whole window).
	 */
	runningMove(): { rec: Recommendation; plan: TimingPlan } | null {
		return this.slots.runningMove();
	}

	on<E extends ExecutorEvent>(event: E, cb: (payload: ExecutorEvents[E]) => void): () => void {
		return this.listeners.on(event, cb);
	}

	/** Start cancellable free movement; the live source also supplies the position/turn gate. */
	exploreOpponent(source: () => OpponentExplorationCandidates | null): void {
		this.explorer.start(source);
	}

	isExploring(): boolean {
		return this.explorer.isExploring();
	}

	// ── scheduling ────────────────────────────────────────────────────────

	/**
	 * Run the hand so the move completes at `plan.deadlineMs`. Replaces any pending
	 * move, including a replacement parked behind a cancelled run (newest wins).
	 */
	schedule(rec: Recommendation, plan: TimingPlan, ctx: MoveContext = {}): void {
		if (this.disposed) return;
		this.slots.schedule(rec, plan, ctx);
	}

	/** Execute the pending move (or `rec`) right away with an instant plan. */
	playNow(
		rec?: Recommendation,
		plan?: TimingPlan,
		ctx?: MoveContext
	): Promise<ExecutionResult | null> {
		return this.slots.playNow(rec, plan, ctx);
	}

	/**
	 * Drop the pending move and any parked replacement; abort a running one (the
	 * hand releases at once) and the board check in flight, if any.
	 */
	cancel(): void {
		this.slots.cancel();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancel();
		this.listeners.clear();
	}

	/** Every event goes out through here (tests intercept it on the instance). */
	private emit<E extends ExecutorEvent>(event: E, payload: ExecutorEvents[E]): void {
		this.listeners.emit(event, payload);
	}
}
