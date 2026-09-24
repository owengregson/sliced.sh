// test/behavioral/game/anticipation-wiring.ts — the timing model's side of anticipatory hover,
// emulated for the executor's tests (2026-09-24).
//
// The interface agreed with the calibration workstream: the session puts the executor's
// `hoverSquare()` into `TimingContext.hoverSquare`. When that square is the chosen move's
// from-square, and the reply was the pondered one or the move is a recapture, the model plans
// the reply with `anticipatedExecution` and stamps `features.anticipated = 1`. That wiring lives
// in `src/core/timing` and `src/service/game-session` on the calibration branch. Until it lands,
// this spy stands in for it, so the hover and the prepared touch can be tested against the plans
// the model will send. A plan that is already anticipated passes through untouched, so the spy is
// harmless once the real wiring exists.
import { spyOn } from "bun:test";
import { parseUci } from "@core/chess/san";
import { anticipatedExecution } from "@core/motor/anticipation";
import { createRng } from "@core/rng";
import { TimingModel } from "@core/timing/timing-model";
import type { Square } from "@typedefs/game";

/** Emulate the anticipated plan; returns the restore function. */
export function emulateAnticipatedPlanning(
	hoverSquare: () => Square | null,
	seed: string
): () => void {
	const original = TimingModel.prototype.planMove;
	const spy = spyOn(TimingModel.prototype, "planMove").mockImplementation(function (
		this: TimingModel,
		ctx
	) {
		const plan = original.call(this, ctx);
		if (plan.mode === "premove" || plan.features.anticipated) return plan;
		const move = parseUci(ctx.chosenMove);
		const last = ctx.moves.at(-1);
		const recapture = last !== undefined && parseUci(last)?.to === move?.to;
		if (!move || hoverSquare() !== move.from || !(recapture || last === ctx.expectedOppReply))
			return plan;
		const a = anticipatedExecution(1, 1, createRng(`${seed}:${ctx.fen}:anticipated`));
		const orientationMs = a.orientationMs;
		const approachMs = (a.hoverS + a.dragS) * 1000;
		const thinkMs = orientationMs + approachMs;
		return {
			...plan,
			mode: "instant",
			thinkMs,
			deadlineMs: ctx.nowMs + thinkMs,
			orientationMs,
			preMoveHoverMs: orientationMs,
			dragDurationMs: a.dragS * 1000,
			window: { orientationMs, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs },
			features: { ...plan.features, anticipated: 1 },
		};
	});
	return () => spy.mockRestore();
}
