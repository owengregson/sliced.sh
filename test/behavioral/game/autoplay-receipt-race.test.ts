import { afterEach, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => h?.dispose());

for (const position of ["next", "same", "unrelated"] as const)
	it(`settles a delayed successful receipt with a ${position}-position recommendation parked behind it`, async () => {
		h = await createGameHarness({
			timeControl: { baseMs: 180_000, incMs: 0 },
			settings: {
				automation: { autoMove: true },
				execution: { verifyMoves: true, previewSelectScale: 0 },
				strength: { useOpeningBook: false },
			},
		});
		let release = (): void => {};
		const heldReceipt = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding = false;
		const request = h.link.request.bind(h.link);
		h.link.request = (async (...args: Parameters<typeof request>) => {
			const reply = await request(...args);
			if (args[1].kind === "observeMove" && !holding) {
				holding = true;
				await heldReceipt;
			}
			return reply;
		}) as typeof h.link.request;
		const executed: ExecutionReport[] = [];
		const skipped: ExecutionReport[] = [];
		h.executor()?.on("executed", (report) => executed.push(report));
		h.executor()?.on("skipped", (report) => skipped.push(report));
		await h.arrive();
		expect(await h.until(() => holding, 60_000)).toBe(true);
		const previous = h.executor()?.runningMove()?.rec;
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		const reply = h.site.board.legalMoves()[0];
		expect(reply).toBeDefined();
		await h.arrive(reply, { w: 179_000, b: 179_000 });
		expect(
			await h.until(() => h.executor()?.pendingMove()?.rec.fen === h.site.board.fen(), 5_000)
		).toBe(true);
		const next = h.executor()?.pendingMove()?.rec;
		expect(next?.fen).not.toBe(previous?.fen);
		if (!next || !previous) throw new Error("Both recommendations must be present");
		// Inject otherwise legal stale/unrelated metadata to exercise duplicate suppression.
		if (position === "same") next.fen = previous.fen;
		if (position === "unrelated")
			next.fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9";
		await h.drive(release);
		if (position !== "next") {
			expect(await h.until(() => skipped.length === 1, 5_000)).toBe(true);
			expect(executed).toHaveLength(1);
			expect(skipped[0]?.result.reason).toBe("position-changed");
			expect(
				h.sim.debugger
					.commandsFor(CDP.inputDispatchMouseEvent)
					.filter((cmd) => cmd.params?.type === "mousePressed")
			).toHaveLength(1);
			return;
		}
		expect(await h.until(() => executed.length === 2, 60_000)).toBe(true);
		expect(skipped).toEqual([]);
		expect(executed.map((report) => report.rec.chosen.uci)).toEqual([
			previous?.chosen.uci,
			next?.chosen.uci,
		]);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		expect(h.session().currentState()).toBe("live:opponent-turn");
		expect(
			h.sim.debugger
				.commandsFor(CDP.inputDispatchMouseEvent)
				.filter((cmd) => cmd.params?.type === "mousePressed")
		).toHaveLength(2);
	});
