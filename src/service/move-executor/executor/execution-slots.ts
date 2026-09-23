/**
 * The executor's execution state: at most one move **pending** (waiting on the scheduler for its
 * fire time), one **running** (in the hand), one **parked** replacement (waiting for a cancelled
 * run to wind down) and one **fast-forward** (`playNow`) in flight. Every transition between them
 * lives here — `schedule`, `playNow`, `cancel`, the timer firing and the run finishing — together
 * with the hand state the runs publish.
 *
 * One execution at a time per tab. After `cancel()` the running execution
 * winds down within one bounded board re-check (release, then a fresh
 * `EXECUTOR.recheckTimeoutMs` check that only a further cancel aborts); a
 * replacement request is *parked* behind it — visible to `pendingMove()`,
 * dropped by `cancel()` / `disarm()` / `dispose()` / a newer `schedule()` —
 * and plays only if the hand is still armed and the run it waited on did
 * *not* land its move, or the recommendation is for the exact next own turn
 * after that move and an opponent reply. A successful receipt suppresses all
 * other replacements, including same-position and queued moves. The next
 * turn still passes its fresh position guard (`dispatch`). A second
 * request while an execution is live (not cancelled) is dropped and the
 * running promise returned: the session owns the "one recommendation per
 * position" rule and must `cancel()` before scheduling a replacement —
 * queueing here would play a stale move. (Queued for Task 30: decide whether
 * a newer recommendation should abort the running one instead.)
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import type { ExecutionResult, HandState } from "@core/motor/types";
import { errorMessage } from "@core/util/errors";
import type { Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { InputCriticalWindow } from "../input-window";
import type { AttachSettle } from "./attach-settle";
import type { BoardChecks } from "./board-checks";
import type { ExecutorContext } from "./context";
import type { MoveDispatcher } from "./dispatch";
import { outcomeEvent } from "./events";
import { readBoardGeometry } from "./geometry";
import { isNextOwnTurn } from "./move-facts";
import type { OpponentExplorer } from "./opponent-explorer";
import { overridesPace, stamp, undispatched } from "./results";
import type { FastForward, Parked, Pending, Running } from "./run-state";
import type { HoldDecision } from "./scramble-hold";
import { fitTiming, instantTiming } from "./timing-fit";
import type { MoveContext } from "./types";

export class ExecutionSlots {
	private pending: Pending | null = null;
	private runningSlot: Running | null = null;
	private fastForward: FastForward | null = null;
	private parked: Parked | null = null;
	private hand: HandState = "rest";
	private lastSkipReason: string | null = null;
	private inputVersion = 0;

	constructor(
		private readonly ctx: ExecutorContext,
		private readonly settle: AttachSettle,
		private readonly checks: BoardChecks,
		private readonly explorer: OpponentExplorer,
		private readonly dispatcher: MoveDispatcher
	) {}

	// ── state ─────────────────────────────────────────────────────────────

	running(): Running | null {
		return this.runningSlot;
	}

	hasPending(): boolean {
		return this.pending !== null;
	}

	handState(): HandState {
		return this.hand;
	}

	/** The last run ended in a skip (the panel's `paused` pill) — `null` after any other outcome. */
	lastSkip(): string | null {
		return this.lastSkipReason;
	}

	setHand(s: HandState): void {
		if (this.hand === s) return;
		this.hand = s;
		this.ctx.emit("hand", s);
	}

	/** See `MoveExecutor.pendingMove`. */
	pendingMove(): { rec: Recommendation; fireAt: number } | null {
		if (this.pending) return { rec: this.pending.rec, fireAt: this.pending.fireAt };
		if (this.parked) return { rec: this.parked.rec, fireAt: this.ctx.now() };
		return null;
	}

	/** Changes on every explicit cancellation, including disarm/dispose and position replacement. */
	cancellationGeneration(): number {
		return this.inputVersion;
	}

	/** Hovering, previews, decision pauses and approach remain interruptible until mouse-down. */
	canFastForward(): boolean {
		return this.runningSlot?.committed !== true;
	}

	/** The move whose piece the hand is holding over its destination, waiting for the opponent. */
	holdingMove(): { rec: Recommendation } | null {
		const running = this.runningSlot;
		return running?.hold && !running.hold.decided ? { rec: running.rec } : null;
	}

	decideHold(decision: HoldDecision): boolean {
		const hold = this.runningSlot?.hold;
		if (!hold || hold.decided) return false;
		hold.resolve(decision);
		return true;
	}

	/** See `MoveExecutor.runningMove`. */
	runningMove(): { rec: Recommendation; plan: TimingPlan } | null {
		const running = this.runningSlot;
		return running ? { rec: running.rec, plan: running.timing } : null;
	}

	// ── transitions ───────────────────────────────────────────────────────

	schedule(rec: Recommendation, plan: TimingPlan, ctx: MoveContext): void {
		const x = this.ctx;
		this.clearPending();
		this.explorer.abort();
		this.parked?.ac.abort();
		const now = x.now();
		const available = plan.deadlineMs - now;
		const fireAt = available > plan.thinkMs ? plan.deadlineMs - plan.thinkMs : now;
		const timing = fitTiming(plan, available);
		const input = this.inputWindow(plan);
		const timer = x.scheduler.setTimeout(
			() => {
				this.pending = null;
				void this.execute(rec, timing, ctx, input);
			},
			Math.max(0, fireAt - now)
		);
		this.pending = { rec, timing, ctx, fireAt, timer, input };
		log.debug("executor: scheduled", {
			tabId: x.tabId,
			uci: rec.chosen.uci,
			fireInMs: fireAt - now,
			thinkMs: timing.thinkMs,
		});
	}

	playNow(
		rec?: Recommendation,
		plan?: TimingPlan,
		ctx?: MoveContext
	): Promise<ExecutionResult | null> {
		const pending = this.pending;
		const running = this.runningSlot;
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
		instant.deadlineMs = this.ctx.now() + instant.thinkMs;
		const done = this.execute(target, instant, ctx ?? pending?.ctx ?? running?.ctx ?? {}).finally(
			() => {
				if (this.fastForward?.done === done) this.fastForward = null;
			}
		);
		this.fastForward = { rec: target, version: this.inputVersion, done };
		return done;
	}

	cancel(): void {
		this.inputVersion += 1;
		this.explorer.abort();
		this.clearPending();
		this.parked?.ac.abort();
		this.runningSlot?.ac.abort();
		this.checks.abort();
	}

	// ── execution ─────────────────────────────────────────────────────────

	private async execute(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		input = this.inputWindow(timing)
	): Promise<ExecutionResult> {
		try {
			return await this.executeWithInput(rec, timing, ctx, input);
		} finally {
			input.close();
		}
	}

	private inputWindow(timing: TimingPlan): InputCriticalWindow {
		const input = new InputCriticalWindow(this.ctx.now, this.ctx.scheduler, (update) =>
			this.ctx.emit("inputCritical", update)
		);
		input.approachAt(timing.deadlineMs - timing.window.approachMs);
		return input;
	}

	private async executeWithInput(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		input: InputCriticalWindow
	): Promise<ExecutionResult> {
		const x = this.ctx;
		const version = this.inputVersion;
		const exploration = this.explorer.current();
		if (exploration) {
			exploration.ac.abort();
			this.explorer.beginWait();
			try {
				await exploration.done;
			} finally {
				this.explorer.endWait();
			}
			if (version !== this.inputVersion || x.isDisposed() || !x.isArmed())
				return this.droppedReplacement(rec);
		}
		let replacement = false;
		if (this.runningSlot) {
			if (!this.runningSlot.ac.signal.aborted) {
				log.warn("executor: execution already running; request dropped (cancel() first)", {
					tabId: x.tabId,
					uci: rec.chosen.uci,
				});
				return this.runningSlot.done;
			}
			const park = { rec, ac: new AbortController() };
			this.parked?.ac.abort();
			this.parked = park;
			let landedBlocks = false;
			while (this.runningSlot && !park.ac.signal.aborted) {
				const previous = this.runningSlot;
				const prior = await previous.done.catch(() => null);
				if (prior?.ok === true && prior.outcome === "executed")
					landedBlocks ||= ctx.queuedPremove === true || !isNextOwnTurn(previous.rec, rec);
			}
			if (this.parked === park) this.parked = null;
			replacement = true;
			if (park.ac.signal.aborted || x.isDisposed() || !x.isArmed()) {
				return this.droppedReplacement(rec);
			}
			if (landedBlocks) return this.landedReplacement(rec);
		}
		if (x.isDisposed()) return this.droppedReplacement(rec);
		const ac = new AbortController();
		const done = this.runOne(rec, timing, ctx, ac.signal, replacement, input);
		this.runningSlot = { rec, timing, ctx, committed: false, ac, done, hold: null };
		try {
			return await done;
		} finally {
			this.runningSlot = null;
		}
	}

	/** A parked replacement that `cancel()` / `disarm()` / `dispose()` dropped: reported, never dispatched. */
	private droppedReplacement(rec: Recommendation): ExecutionResult {
		const x = this.ctx;
		log.info("executor: parked replacement dropped", {
			tabId: x.tabId,
			uci: rec.chosen.uci,
			armed: x.isArmed(),
			disposed: x.isDisposed(),
		});
		const result = stamp(
			rec,
			undispatched("aborted", EXECUTOR.reasons.dropped, x.ownership.position(x.tabId), 0),
			x.now()
		);
		if (!x.isDisposed()) x.emit("aborted", { rec, result });
		return result;
	}

	/** The run a replacement waited on landed its move: the position moved on, nothing is dispatched. */
	private landedReplacement(rec: Recommendation): ExecutionResult {
		const x = this.ctx;
		log.info("executor: interrupted move landed; parked replacement not dispatched", {
			tabId: x.tabId,
			uci: rec.chosen.uci,
		});
		const result = stamp(
			rec,
			undispatched("skipped", EXECUTOR.reasons.positionChanged, x.ownership.position(x.tabId), 0),
			x.now()
		);
		x.emit("skipped", { rec, result });
		return result;
	}

	private async runOne(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		signal: AbortSignal,
		replacement: boolean,
		input: InputCriticalWindow
	): Promise<ExecutionResult> {
		const x = this.ctx;
		const t0 = x.now();
		const fail = (reason: string, error?: string): ExecutionResult => {
			const r = undispatched("failed", reason, x.ownership.position(x.tabId), x.now() - t0);
			if (error !== undefined) r.error = error;
			return r;
		};
		let result: ExecutionResult;
		try {
			await this.settle.settle(signal);
			if (!x.debugger.isAttached(x.tabId)) {
				log.warn("executor: debugger not attached at execution time (arm first)", {
					tabId: x.tabId,
					lastError: x.debugger.lastError(x.tabId) ?? null,
				});
				result = fail(EXECUTOR.reasons.notAttached);
			} else {
				const reply = await readBoardGeometry(x.link, x.tabId, undefined, signal);
				if (reply)
					result = await this.dispatcher.dispatch(rec, timing, ctx, reply, signal, replacement, input);
				else if (signal.aborted) {
					// cancel() during the initial geometry read: nothing was dispatched
					result = { ...fail(EXECUTOR.reasons.aborted), outcome: "aborted" };
				} else result = fail(EXECUTOR.reasons.noGeometry);
			}
		} catch (error) {
			result = fail(EXECUTOR.reasons.dispatchFailed, errorMessage(error));
		}
		this.setHand("rest");
		if (overridesPace(rec, timing.mode, result, this.fastForward?.rec === rec))
			result = { ...result, paceOverride: true };
		this.lastSkipReason = result.outcome === "skipped" ? (result.reason ?? null) : null;
		result = stamp(rec, result, x.now());
		x.emit(outcomeEvent(result.outcome), { rec, result });
		return result;
	}

	private clearPending(): void {
		if (!this.pending) return;
		this.ctx.scheduler.clearTimeout(this.pending.timer);
		this.pending.input.close();
		this.pending = null;
	}
}
