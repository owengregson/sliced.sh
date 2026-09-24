/**
 * The per-tab `MoveExecutor`'s lifecycle as the session sees it: building (or replacing) the hand,
 * subscribing to its reports, and what each terminal report means for the §3.3 state, the board
 * mark, review admission, the move accounting and Fix G's recovery.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import type { ExecutionReport } from "@service/move-executor";
import { isMyTurnState } from "../transitions";
import type { BoardMarks } from "./board-marks";
import type { SessionCore } from "./core";
import type { HandArming } from "./hand-arming";
import type { MoveRecorder } from "./move-recorder";
import type { QueuedPremove } from "./queued-premove";
import type { Redelivery } from "./redelivery";
import type { ReviewAdmission } from "./review-admission";
import type { ExecutorFactory } from "./types";

export interface ExecutorBindingParts {
	hand: HandArming;
	admission: ReviewAdmission;
	queue: QueuedPremove;
	marks: BoardMarks;
	recorder: MoveRecorder;
	redelivery: Redelivery;
}

export class ExecutorBinding {
	private offs: Array<() => void> = [];

	constructor(
		private readonly core: SessionCore,
		private readonly parts: ExecutorBindingParts
	) {}

	attach(config: Parameters<ExecutorFactory>[0]): void {
		const core = this.core;
		const previous = core.executor;
		// A hand released for a session break counts as armed here: the break is over.
		const wasArmed = this.parts.hand.takeCarriedArm(previous);
		const executor = core.deps.createExecutor(config);
		for (const off of this.offs.splice(0)) off();
		// A factory may legitimately hand the same executor back (one hand for the whole tab);
		// only a *replacement* retires the old one.
		if (previous && previous !== executor) {
			previous.dispose();
			this.parts.admission.retire(previous);
		}
		core.executor = executor;
		this.offs = [
			executor.on("inputCritical", (update) => this.parts.admission.onInputCritical(executor, update)),
			executor.on("executed", (report) => this.onExecuted(report)),
			// Fix F: the premove gesture went out. Nothing has been played — and nothing can tell
			// whether the site kept it — so it is not `executed` and none of `onExecuted`'s
			// accounting runs on it.
			executor.on("dispatched", (report) => void this.parts.queue.settleDrag(report)),
			executor.on("failed", (report) => this.onFailed(report)),
			executor.on("aborted", (report) => this.onNotExecuted(report, "aborted")),
			executor.on("skipped", (report) => this.onNotExecuted(report, "skipped")),
			executor.on("hand", (hand) => {
				if (hand === "rest") {
					return;
				}
				// Fix F: the hand also leaves rest during the *opponent's* turn now, to send a premove,
				// and §3.3 has no `handStarted` edge there on purpose — the move is not ours to make yet.
				// The gate changes no state (the table already rejects that edge); what it removes is one
				// `log.warn("no transition")` per hand phase per premove.
				//
				// It gates the redraw below as well, and that part is not cosmetic. `markForExecution`
				// inserts an overlay `<svg>` on the board; doing that for a premove would insert it during
				// the *opponent's* turn, which is a different §13.3 window from the one Fix A measured and
				// neither lane tested. Whether a premove's mark should be ours too is a separate question,
				// left open deliberately — a premove keeps the native mark it was drawn with.
				if (!isMyTurnState(core.state)) return;
				core.apply("handStarted");
				// The hand is acting: the mark must now be one the site cannot take away.
				this.parts.marks.markForExecution();
			}),
			executor.on("pointer", (p) => this.parts.marks.cursorTo(p)),
		];
		// A game that follows an armed one keeps the hand armed (the debugger stays attached), and
		// `Settings.automation.autoMove` is the stored "arm me" default.
		// Fix G: and the arm is awaited for its *result*, not fired and forgotten. `arm()` attaches
		// the debugger, which is slow enough to lose the race with the first position — and the
		// manual arm (Shift+A) has always re-checked the recommendation it may have raced, while
		// this path did not. At ply 0 as white that re-check is the only one there will ever be.
		this.parts.hand.armNewExecutor(executor, wasArmed);
	}

	detach(): void {
		const core = this.core;
		for (const off of this.offs.splice(0)) off();
		if (core.executor) {
			core.executor.dispose();
			this.parts.admission.retire(core.executor);
		}
		core.executor = null;
	}

	private onExecuted(report: ExecutionReport): void {
		const core = this.core;
		// A premove's report settles the fork and stops here, so it never reaches the clear below —
		// deliberately. The mark of a queued premove is not a spent prediction, it is the move that is
		// about to play, and it stays on the board for exactly as long as that is true: the opponent
		// moving brings a new position, and `onPosition`'s own clear erases it there. This is the one
		// mark that outlives its own action, and it outlives it by design.
		if (this.parts.queue.settleDrag(report)) return;
		if (report.rec.chosen.source === "premove") this.parts.queue.notePlayed();
		const current = report.rec === core.rec;
		if (current) this.parts.admission.update();
		// The position feed can reach us before the confirmation. It already opened
		// the next window, which this older receipt must not transition or clear.
		if (current) core.apply("executed");
		// The move is on the board: the prediction has been spent, and the site's own last-move
		// marking is what belongs there now.
		if (current) this.parts.marks.clear();
		this.parts.recorder.recordMove(report, current);
		core.notify();
	}

	private onFailed(report: ExecutionReport): void {
		if (this.parts.queue.settleDrag(report)) return;
		log.warn("game-session: execution failed", {
			tabId: this.core.tabId,
			uci: report.rec.chosen.uci,
			reason: report.result.reason ?? null,
		});
		this.onNotExecuted(report, "failed");
	}

	/**
	 * Every outcome that is not `executed` is a `failed` edge for §3.3: the hand has stopped and
	 * the move did not land, so `live:my-turn:executing` must fall back to `recommended` rather
	 * than sit in a state whose hand is at rest. This is the path a §13.4 blur cancel takes
	 * (`aborted`), as well as the position guard (`skipped`) and a genuine failure.
	 *
	 * **The mark goes too — but only if it is still this attempt's mark.** An attempt that finally
	 * failed is the action being complete, so it is a clear point exactly as `executed` is. There is
	 * no retry left that could want it: `MoveExecutor.runOne` emits `failed` / `aborted` / `skipped`
	 * only after `dispatch()` has returned, and `dispatch()` is where `runWithRetry` exhausts every
	 * tier. Leaving it drawn stranded an overlay `<svg>` for a move that will never be played — and
	 * the overlay is ours, so unlike the native marking it used to be, nothing on the page ever
	 * wipes it (the known promotion gap, QA B0.7, reaches this path on every live game).
	 *
	 * The `report.rec === core.rec` test is not belt-and-braces, it is the correctness condition.
	 * `cancelInFlight()` does not await `MoveExecutor.cancel()`, and the hand's wind-down (the
	 * release, `recover()`, the hops back) is slower than producing the next recommendation — so
	 * when a position arrives on our turn mid-action the **default** ordering is: the run is
	 * cancelled, the new position is analysed, the new recommendation's mark is drawn, and only
	 * *then* does the cancelled run emit `aborted`. An unconditional clear there erased the mark of
	 * a recommendation that is live, leaving the panel recommending a move and the board blank —
	 * this lane's own bug, reintroduced from the other end. Three more emit sites reach here for a
	 * recommendation that may no longer be current: `droppedReplacement` and `landedReplacement`
	 * (`move-executor/index.ts`) both fire for a parked move the session has already moved past.
	 */
	private onNotExecuted(report: ExecutionReport, outcome: "aborted" | "skipped" | "failed"): void {
		const core = this.core;
		if (this.parts.queue.settleDrag(report)) return;
		if (report.rec === core.rec) {
			this.parts.admission.update();
			core.apply("failed");
			core.window.discard();
			this.parts.marks.clear();
			const reason = report.result.reason;
			const noPress =
				report.result.attempts === 0 &&
				report.result.pressed !== true &&
				report.result.pressedAny !== true;
			if (
				noPress &&
				(reason === EXECUTOR.reasons.noGeometry || reason === EXECUTOR.reasons.verificationUnavailable)
			)
				this.parts.redelivery.heldRecommendation(report.rec, `pre-dispatch hold: ${reason}`);
		}
		log.debug("game-session: move did not land", {
			tabId: core.tabId,
			outcome,
			uci: report.rec.chosen.uci,
			reason: report.result.reason ?? null,
			state: core.state,
		});
		core.notify();
	}
}
