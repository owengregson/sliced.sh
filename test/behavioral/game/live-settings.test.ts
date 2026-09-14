import { afterEach, expect, it, spyOn } from "bun:test";
import { MSG } from "@core/constants/messages";
import { SETTING_GAIN } from "@core/constants/setting-gain";
import type { ExecutionPlan } from "@core/motor/types";
import { HandController } from "@service/move-executor/hand-controller";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let restore: (() => void) | undefined;
afterEach(async () => {
	await h?.dispose();
	restore?.();
	restore = undefined;
});

it("live timing and mouse controls update the next move while the current gesture keeps its plan", async () => {
	const plans: ExecutionPlan[] = [];
	const original = HandController.prototype.execute;
	const execution = spyOn(HandController.prototype, "execute").mockImplementation(function (
		this: HandController,
		plan,
		timing,
		signal
	) {
		plans.push(plan);
		return original.call(this, plan, timing, signal);
	});
	restore = () => execution.mockRestore();
	h = await createGameHarness({
		settings: {
			automation: { autoMove: true },
			timing: { profile: "custom", speedScale: 1 },
			execution: { motorSpeed: 1, previewSelectScale: 0, verifyMoves: false },
		},
		head: {
			id: "v1-parametric",
			median: () => 8,
			sample: () => ({ tSec: 8, mode: "normal", why: [] }),
		},
	});
	await h.arrive();
	expect(await h.until(() => h.executor()?.handState() === "orientation", 10_000)).toBe(true);
	const executor = h.executor();
	const current = h.session().recommendation()!;
	const currentPlan = structuredClone(current.plan);
	expect(plans).toHaveLength(1);
	expect(plans[0]).toMatchObject({
		// the user's 1 through `SETTING_GAIN` (2026-09-13); previews off stays 0
		motorSpeed: SETTING_GAIN.motorSpeed,
		exploration: { persona: "balanced", previewScale: 0 },
	});

	await h.patch({
		strength: { persona: "blitz" },
		timing: { profile: "manual", speedScale: 0.3, premoveTendency: 0.9 },
		execution: { motorSpeed: 2, previewSelectScale: 2, verifyMoves: true },
	});
	expect(h.executor()).toBe(executor);
	expect(h.session().recommendation()).toBe(current);
	expect(current.plan).toEqual(currentPlan);
	expect(plans).toHaveLength(1);
	expect(plans[0]).toMatchObject({
		// the user's 1 through `SETTING_GAIN` (2026-09-13); previews off stays 0
		motorSpeed: SETTING_GAIN.motorSpeed,
		exploration: { persona: "balanced", previewScale: 0 },
	});
	expect(await h.until(() => h.site.board.lastMove() !== null, 12_000)).toBe(true);
	await h.advance(1500);
	expect(plans).toHaveLength(1);

	await h.arrive(h.site.board.legalMoves()[0]!);
	expect(
		await h.until(() => {
			const next = h.session().recommendation();
			return next !== null && next !== current;
		}, 10_000)
	).toBe(true);
	const next = h.session().recommendation()!;
	expect(next.plan.thinkMs).toBeLessThan(currentPlan.thinkMs * 0.6);
	// Manual mode is also live: the newly computed plan waits for the explicit shortcut.
	await h.advance(next.plan.thinkMs + 1000);
	expect(plans).toHaveLength(1);
	const request = h.drive(() =>
		h.router._dispatch({ type: MSG.PANEL_KEYBIND, tabId: h.tabId, action: "playMove" }, {})
	);
	expect(await h.until(() => plans.length === 2, 2000)).toBe(true);
	expect(plans[1]).toMatchObject({
		motorSpeed: 2 * SETTING_GAIN.motorSpeed,
		// The persona is forced to balanced on every read (2026-09-12); the write is ignored.
		exploration: { persona: "balanced", previewScale: 2 * SETTING_GAIN.previewSelectScale },
	});
	expect(await h.until(() => h.site.board.chess.history().length === 3, 3000)).toBe(true);
	await h.advance(1000);
	expect(await request).toMatchObject({ success: true });
});
