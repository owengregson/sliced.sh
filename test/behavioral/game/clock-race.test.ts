import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import type { OpponentExplorationCandidates } from "@core/motor/opponent-candidates";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

async function start(fen?: string): Promise<void> {
	h = await createGameHarness({
		myColor: "b",
		...(fen ? { fen } : {}),
		seed: "fast-execution",
		timeControl: { baseMs: 180_000, incMs: 0 },
		settings: { automation: { autoMove: true }, strength: { useOpeningBook: false } },
		head: { id: "chessmimic", median: () => 10, sample: () => ({ tSec: 10, mode: "long", why: [] }) },
	});
}

describe("clock-race session integration", () => {
	for (const scenario of [
		{
			name: "opponent clock under ten seconds",
			reply: "e2e4",
			clocks: { w: 1000, b: 60_000 },
			fen: undefined,
		},
		{
			name: "our clock under five seconds",
			reply: "e2e4",
			clocks: { w: 60_000, b: 1000 },
			fen: undefined,
		},
		{
			name: "lone king with ample clocks",
			reply: "f4f5",
			clocks: { w: 60_000, b: 60_000 },
			fen: "k7/8/8/4K3/5Q2/8/8/8 w - - 0 40",
		},
	])
		it(`delivers the actual move quickly: ${scenario.name}`, async () => {
			await start(scenario.fen);
			await h.arrive(null, { w: 8000, b: 60_000 });
			await h.advance(500);
			const started = h.sim.time.now();
			await h.arrive(scenario.reply, scenario.clocks);
			expect(
				await h.until(
					() =>
						h.sim.debugger
							.commandsFor(CDP.inputDispatchMouseEvent)
							.some((command) => command.params?.type === "mouseReleased"),
					400,
					5
				)
			).toBe(true);
			const events = h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
			const press = events.filter((command) => command.params?.type === "mousePressed");
			const release = events.filter((command) => command.params?.type === "mouseReleased");
			expect(press).toHaveLength(1);
			expect(release).toHaveLength(1);
			expect(release[0]!.at - started).toBeLessThan(300);
			expect(
				h.transport.goLines
					.filter((line) => !line.includes("infinite"))
					.every((line) => Number(/movetime (\d+)/.exec(line)?.[1]) < 100)
			).toBe(true);
			expect(h.site.board.fen().split(" ")[1]).toBe("w");
			expect(await h.until(() => !h.executor()?.isRunning(), 500, 5)).toBe(true);
		});

	it("refreshes own-only exploration from clocks without another position change", async () => {
		await start();
		const reader: { source?: () => OpponentExplorationCandidates | null } = {};
		const executor = h.executor()!;
		const original = executor.exploreOpponent.bind(executor);
		executor.exploreOpponent = (source) => {
			reader.source = source;
			original(source);
		};
		await h.arrive(null, { w: 12_000, b: 60_000 });
		expect(reader.source?.()?.policy).toEqual({ ownOnly: false, lowTime: false });
		await h.advance(2500);
		expect(reader.source?.()?.policy).toEqual({ ownOnly: true, lowTime: true });
	});

	it("keeps tactical exploration on our replies even with ample clocks", async () => {
		// White must answer Black's rook check before Black can move again.
		await start("4k3/8/8/8/8/8/4r3/4K3 w - - 0 40");
		const reader: { source?: () => OpponentExplorationCandidates | null } = {};
		const executor = h.executor()!;
		const original = executor.exploreOpponent.bind(executor);
		executor.exploreOpponent = (source) => {
			reader.source = source;
			original(source);
		};
		await h.arrive(null, { w: 60_000, b: 60_000 });
		expect(reader.source?.()?.policy).toEqual({ ownOnly: true, lowTime: false });
	});
});
