// test/behavioral/game/input-method.test.ts — the flag the whole drag-only change hangs off.
//
// `TimingContext.inputMethod` is what `move-window.ts`'s motor model branches on: `"drag"` fits the
// window to a Fitts drag, `"click"` to a two-click gap. Both producers in the session now pass
// `EXECUTOR.committedTier`, but `MotorInputs.inputMethod` is still a `"drag" | "click"` union owned
// by the timing lane, so flipping either site to `"click"` typechecks — and nothing failed. The
// committed move would still be a drag (there is exactly one committed press and it is inside
// `drag()`), but every move window would be fitted to a movement the hand never makes.
//
// So pin it where it is consumed: every context the orchestrator hands the timing model, on the
// first plan (`recommendation.ts` builds it from the pipeline input) and on a replan
// (`session.timingContextFor`, reached here by a blur inside the window), names the committed tier.
import { afterEach, describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants/cdp";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let restore: (() => void) | null = null;

afterEach(async () => {
	restore?.();
	restore = null;
	await h?.dispose();
});

describe("game session: the timing model is always told the move is a drag", () => {
	it("every planned and replanned TimingContext names EXECUTOR.committedTier", async () => {
		const planned: Array<TimingContext["inputMethod"]> = [];
		const replanned: Array<TimingContext["inputMethod"]> = [];
		const planMove = TimingModel.prototype.planMove;
		const replan = TimingModel.prototype.replan;
		TimingModel.prototype.planMove = function patchedPlan(this: TimingModel, ctx: TimingContext) {
			planned.push(ctx.inputMethod);
			return planMove.call(this, ctx);
		};
		TimingModel.prototype.replan = function patchedReplan(
			this: TimingModel,
			...args: Parameters<TimingModel["replan"]>
		) {
			replanned.push(args[1].inputMethod);
			return replan.apply(this, args);
		};
		restore = () => {
			TimingModel.prototype.planMove = planMove;
			TimingModel.prototype.replan = replan;
		};

		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 5_000)).toBe(true);
		// A blur inside the move window is the replan path (§13.4): the execution is cancelled and
		// the plan is rebuilt through `session.timingContextFor`.
		await h.drive(() => h.site.panelClick());
		await h.advance(50);

		expect(planned.length).toBeGreaterThan(0);
		expect(replanned.length).toBeGreaterThan(0);
		expect([...new Set([...planned, ...replanned])]).toEqual([EXECUTOR.committedTier]);
	});
});
