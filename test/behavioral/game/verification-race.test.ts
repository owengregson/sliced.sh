import { afterEach, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => h?.dispose());

it("reports a landed move once when the position feed cancels its pending verification", async () => {
	let checks = 0;
	h = await createGameHarness({
		settings: {
			automation: { autoMove: true },
			execution: { verifyMoves: true, previewSelects: "off" },
		},
		onCommand(cmd) {
			if (cmd.kind !== "observeMove" || ++checks !== 1) return;
			// Real content posts the accepted board position before its observeMove reply.
			h.site.arrive(null, { w: 179_000, b: 180_000 });
		},
	});
	const executed: ExecutionReport[] = [];
	const failed: ExecutionReport[] = [];
	h.executor()?.on("executed", (report) => executed.push(report));
	h.executor()?.on("failed", (report) => failed.push(report));
	await h.arrive();
	expect(await h.until(() => executed.length > 0 || failed.length > 0, 60_000)).toBe(true);
	expect(failed).toEqual([]);
	expect(executed).toHaveLength(1);
	expect(executed[0]?.result).toMatchObject({ ok: true, outcome: "executed", attempts: 1 });
	expect(checks).toBe(2);
	expect(h.site.board.lastMove()?.uci).toBe(executed[0]?.rec.chosen.uci);
	expect(h.session().currentState()).toBe("live:opponent-turn");
	await h.advance(100);
	const panel = await h.snapshot();
	expect(panel.session.ply).toBe(1);
	expect(panel.session.lastExecution?.outcome).toBe("executed");
	expect(panel.stats.moves).toBe(1);
	const presses = h.sim.debugger.commands.filter(
		(cmd) => cmd.method === CDP.inputDispatchMouseEvent && cmd.params?.type === "mousePressed"
	);
	expect(presses).toHaveLength(1);
});
