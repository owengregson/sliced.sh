/**
 * One move handed to the hand: the position guard, the hand for this move (its seeded streams,
 * backend and callbacks), the plan, the scramble hold and the line preview, then the attempts —
 * one entry for a premove, `runWithRetry` with verification for everything else.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { SCRAMBLE_HOLD } from "@core/constants/hold";
import type { BoardGeometryReply } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { ExplorationPlanner } from "@core/motor/exploration";
import { plausibleStart } from "@core/motor/sampling";
import type {
	BoardGeometry,
	ExecutionPlan,
	ExecutionResult,
	HandState,
	Pt,
} from "@core/motor/types";
import { createRng } from "@core/rng";
import { remainingMoveWindow } from "@core/timing/move-window";
import { sleep } from "@core/util/scheduler";
import type { Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { boardGeometryOf, HandController } from "../hand-controller";
import type { InputCriticalWindow } from "../input-window";
import { runWithRetry } from "../retry-policy";
import { type VerifyResult, verifyMove } from "../verifier";
import { createBackend } from "./backend";
import type { BoardChecks } from "./board-checks";
import type { ExecutorContext } from "./context";
import type { LinePreviewAllowance } from "./line-previews";
import { moveKindOf } from "./move-facts";
import { executionPlanOf, expectedMoveOf, inputStyleOf, moveMotorProfile } from "./move-plan";
import { undispatched } from "./results";
import type { Running } from "./run-state";
import { ScrambleHold } from "./scramble-hold";
import { fitTiming, instantTiming } from "./timing-fit";
import type { ExecutorGameConfig, MoveContext } from "./types";

/** The executor state a dispatch reads and writes while its move is in the hand. */
export interface DispatchHost {
	/** The running execution (always this dispatch's own while it runs). */
	running(): Running | null;
	handState(): HandState;
	setHand(state: HandState): void;
}

export class MoveDispatcher {
	constructor(
		private readonly ctx: ExecutorContext,
		private readonly host: DispatchHost,
		private readonly checks: BoardChecks,
		private readonly previews: LinePreviewAllowance,
		/** Shared for this game so attention can persist across moves. */
		private readonly planner: ExplorationPlanner
	) {}

	async dispatch(
		rec: Recommendation,
		timing: TimingPlan,
		ctx: MoveContext,
		reply: BoardGeometryReply,
		signal: AbortSignal,
		replacement: boolean,
		input: InputCriticalWindow
	): Promise<ExecutionResult> {
		const x = this.ctx;
		const config = { ...x.config };
		const readAt = x.now();
		const expected = expectedMoveOf(rec);
		// Fix F: a premove sent during the opponent's turn (`MoveContext.queuedPremove`).
		const queued = ctx.queuedPremove === true;
		// The scramble hold is also entered during the opponent's turn, so its destination is guarded
		// the way a premove's is; the release itself lands on our turn and is verified like a move.
		const holding = ctx.holdUntilReply === true;
		// Position guard: never dispatch on a position that already changed (a replacement after a
		// cancelled run, or any reply whose occupancy says the piece left the from-square).
		const guard = await this.checks.positionChanged(
			rec,
			reply,
			replacement || ctx.requirePositionCheck === true,
			x.config.verifyMoves,
			queued || holding,
			ctx.requirePositionCheck === true
		);
		if (guard !== null) {
			log.info("executor: position guard vetoed the committed press; not dispatching", {
				tabId: x.tabId,
				uci: rec.chosen.uci,
				...guard,
			});
			return undispatched(
				guard.outcome,
				guard.reason,
				x.ownership.position(x.tabId),
				x.now() - readAt
			);
		}
		const geo = boardGeometryOf(reply);
		const moveRng = createRng(`${config.gameSeed}:${rec.fen}:${rec.chosen.uci}`);
		// A premove MUST be a drag, and since click-to-move was removed every committed move is
		// one, so there is nothing to choose here any more. Keeping the reason on the record: a
		// click-click premove would press the destination square as a second selection, and a
		// premove's destination is routinely one of our own pieces (a recapture), so the site
		// would read that press as "select that piece instead" and leave a selection standing,
		// which §13.7 item 3 forbids outright. The drag is also the gesture the site's premove UI
		// is built around.
		const moveKind = ctx.moveKind ?? moveKindOf(rec);
		const motor = moveMotorProfile(config, moveKind, moveRng);
		const start =
			x.ownership.position(x.tabId) ??
			plausibleStart(geo.boardRect, moveRng, geo.squareRect(rec.chosen.from));
		x.ownership.setPosition(x.tabId, start);
		const backend = createBackend(x, start);
		const controller = new HandController({
			backend,
			planner: this.planner,
			focus: x.focus,
			ownership: x.ownership,
			geometry: x.geometry,
			...(x.board ? { board: x.board } : {}),
			rng: moveRng,
			now: x.now,
			scheduler: x.scheduler,
			onState: (s) => this.host.setHand(s),
			onInputDeadline: (at) => input.approachAt(at),
			onCriticalInput: (busy) => input.setCritical(busy),
			onCommittedPress: () => {
				const running = this.host.running();
				if (!running || running.ac.signal !== signal || running.committed) return;
				running.committed = true;
				// The hand was already `grabbing` during the pre-grab pause. Publish the exact
				// availability boundary even though its display phase has not changed.
				x.emit("hand", this.host.handState());
			},
		});
		const plan = executionPlanOf({
			tabId: x.tabId,
			site: x.site,
			rec,
			ctx,
			config,
			geo,
			reply,
			readAt,
			motor,
			premove: queued || holding,
		});
		plan.style = inputStyleOf(config, rec, ctx, queued || holding);
		let hold: ScrambleHold | null = null;
		if (holding) {
			hold = new ScrambleHold(x.scheduler, ctx.holdMaxMs ?? SCRAMBLE_HOLD.scrambleHoldMs[1], {
				tabId: x.tabId,
				uci: rec.chosen.uci,
			});
			const running = this.host.running();
			if (running?.rec === rec) running.hold = hold.handle;
			plan.hold = hold.directive;
		}
		// Optional normal verification never disables the evidence check after a failed
		// or interrupted press: even a preview release might have submitted a move.
		const check = (timeoutMs: number, checkSignal: AbortSignal): Promise<VerifyResult> =>
			verifyMove(x.link, x.tabId, expected, timeoutMs, checkSignal);
		try {
			// Setup and replacement verification consume the original move window too.
			const room = remainingMoveWindow(timing, x.now());
			const readyTiming = fitTiming(timing, room.remainingMs);
			const running = this.host.running();
			if (running?.rec === rec) running.timing = readyTiming;
			if (queued) return await this.enterPremove(controller, plan, readyTiming, signal);
			this.planLinePreview(plan, rec, ctx, config, readyTiming, holding, start, geo);
			return await runWithRetry({
				attempt: (index) =>
					controller.execute(plan, index === 0 ? readyTiming : instantTiming(readyTiming), signal),
				verify: (timeoutMs, checkSignal) =>
					config.verifyMoves ? check(timeoutMs, checkSignal) : Promise.resolve({ outcome: "ok" }),
				recheck: (checkSignal) => check(EXECUTOR.recheckTimeoutMs, checkSignal),
				checkSignal: () => this.checks.freshSignal(),
				delay: (ms) => sleep(ms, x.scheduler, signal),
				verifyTimeoutMs: TIMINGS.executorVerifyTimeoutMs,
				signal,
			});
		} finally {
			this.checks.clear();
			hold?.dispose();
			backend.dispose();
		}
	}

	/**
	 * The line preview (`LINE_PREVIEW`), on the plan the hand will actually run (`readyTiming`; a
	 * retry's instant plan never draws) and never on a premove (`LinePreviewAllowance` has the rest).
	 */
	private planLinePreview(
		plan: ExecutionPlan,
		rec: Recommendation,
		ctx: MoveContext,
		config: ExecutorGameConfig,
		readyTiming: TimingPlan,
		holding: boolean,
		cursor: Pt,
		geo: BoardGeometry
	): void {
		const preview = this.previews.plan(
			{
				fen: rec.fen,
				chosenUci: rec.chosen.uci,
				lines: rec.lines,
				timing: readyTiming,
				myClockMs: ctx.myClockMs ?? 0,
				premove: holding,
				...(ctx.lastMove ? { lastMoveTo: ctx.lastMove.to } : {}),
				profile: plan.motor,
				geometry: geo,
				cursor,
				seed: `${config.gameSeed}:${rec.fen}:${rec.chosen.uci}:line:paths`,
				mode: config.linePreview ?? "auto",
			},
			`${config.gameSeed}:${rec.fen}:${rec.chosen.uci}:line`
		);
		if (!preview) return;
		plan.linePreview = preview;
		log.debug("executor: line preview planned", {
			tabId: this.ctx.tabId,
			uci: rec.chosen.uci,
			lines: preview.lines.map((l) => `${l.uci}×${l.arrows.length}`),
			reserveMs: Math.round(preview.reserveMs),
			thisGame: this.previews.count(),
		});
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
			tabId: this.ctx.tabId,
			uci: plan.expected.uci,
		});
		return { ...result, outcome: "dispatched" };
	}
}
