import { afterEach, expect, it } from "bun:test";
import type { PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => h?.dispose());

it("refreshes panel clock anchors on an unchanged position without replacing its recommendation or restarting search", async () => {
	const timeControl = { baseMs: 60_000, incMs: 0 };
	h = await createGameHarness({
		timeControl,
		settings: { automation: { autoMove: false } },
	});
	await h.arrive();
	expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
	const recommendation = h.session().recommendation();
	const searches = [...h.transport.goLines];
	for (const reading of [
		{ ms: 59_000, running: true },
		{ ms: 59_000, running: false },
		{ ms: 61_500, running: true },
	]) {
		await h.advance(100);
		const snapshot: PositionSnapshot = {
			site: "chesscom",
			gameId: h.site.gameId,
			fen: h.site.board.fen(),
			ply: 0,
			sideToMove: "w",
			myColor: "w",
			timeControl,
			clocks: { w: reading, b: { ms: 60_000, running: false } },
			capturedAt: h.sim.now(),
		};
		await h.drive(() => h.site.post({ kind: "position", snapshot }));
		const panel = await h.snapshot();
		expect(panel.session.clocks?.w).toEqual(reading);
		expect(panel.session.clocksAt).toBe(snapshot.capturedAt);
		expect(h.session().recommendation()).toBe(recommendation);
		expect(h.transport.goLines).toEqual(searches);
	}
});
