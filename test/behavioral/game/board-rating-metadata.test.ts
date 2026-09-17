import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { GamePortCommand } from "@core/constants/messages";
import type { BoardEffectsReporter } from "@service/game-session/board-effects";
import type { PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

const TC = { baseMs: 180_000, incMs: 0 };
let h: GameHarness;
const restores: Array<() => void> = [];
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	await h?.dispose();
});

type Effects = Extract<GamePortCommand, { kind: "effects" }>;
const ratings = (): Effects[] =>
	h
		.commands()
		.filter((command): command is Effects => command.kind === "effects" && !!command.quality);
const reporter = (): BoardEffectsReporter =>
	(h.session() as unknown as { boardEffects: BoardEffectsReporter }).boardEffects;

/** Real game-port arrivals, split as when exact board/ply precedes bridge or move-list metadata.
 * ChessComAdapter.read selects its FEN separately from replay/bridgeLastMove; a later clock
 * reading republishes the snapshot through AdapterBase.apply even when placement is unchanged.
 */
function position(withLast: boolean, over: Partial<PositionSnapshot> = {}): PositionSnapshot {
	const last = h.site.board.lastMove();
	return {
		site: "chesscom",
		gameId: h.site.gameId,
		fen: h.site.board.fen(),
		ply: h.site.board.ply(),
		sideToMove: h.site.board.chess.turn(),
		myColor: "b",
		approximate: false,
		timeControl: TC,
		clocks: { w: { ms: 179_000, running: false }, b: { ms: 180_000, running: true } },
		capturedAt: h.sim.now(),
		...(withLast && last ? { lastMove: { from: last.from, to: last.to, san: last.san } } : {}),
		...over,
	};
}
const post = (snapshot: PositionSnapshot): Promise<void> =>
	h.drive(() => h.site.post({ kind: "position", snapshot }));

async function start(): Promise<void> {
	h = await createGameHarness({
		myColor: "b",
		timeControl: TC,
		settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
	});
	await h.arrive();
	await h.advance(100);
}

async function missing(
	uci: string,
	over: Partial<PositionSnapshot> = {}
): Promise<PositionSnapshot> {
	h.site.board.applyOpponent(uci);
	const snapshot = position(false, over);
	await post(snapshot);
	return snapshot;
}

describe("board ratings from late lastMove metadata", () => {
	it("recovers four consecutive moves exactly once without restarting the playing pipeline or executor", async () => {
		await start();
		const executor = h.executor()!;
		const cancel = spyOn(executor, "cancel");
		restores.push(() => cancel.mockRestore());
		for (const [i, uci] of ["e2e4", "e7e5", "g1f3", "b8c6"].entries()) {
			await missing(uci);
			await h.advance(100);
			expect(ratings()).toHaveLength(i);
			const rec = h.session().recommendation();
			const state = h.session().currentState();
			const playingCommands = [...h.transport.sent];
			const cancellations = cancel.mock.calls.length;
			const plans = h.timingLog.entries().length;
			// Same FEN/ply, enriched metadata on a later clock reading; no new move occurred.
			const enriched = position(true);
			await post(enriched);
			expect(h.session().recommendation()).toBe(rec);
			expect(h.session().currentState()).toBe(state);
			expect(h.transport.sent).toEqual(playingCommands);
			expect(cancel).toHaveBeenCalledTimes(cancellations);
			expect(h.timingLog.entries()).toHaveLength(plans);
			expect(await h.until(() => ratings().length === i + 1, 2_000)).toBe(true);
			expect<string | undefined>(ratings().at(-1)?.quality?.square).toBe(uci.slice(2, 4));
			await post(enriched); // exact duplicate must not rate again
			await h.advance(10);
			expect(ratings()).toHaveLength(i + 1);
		}
		expect(reporter().stats()).toEqual({ delivered: 4, dropped: {} });
	});

	it("rejects a stale but legal lastMove without consuming the later correct recovery", async () => {
		await start();
		const snapshot = await missing("e2e4");
		await post({ ...snapshot, lastMove: { from: "d2", to: "d4", san: "d4" } });
		await h.advance(100);
		expect(ratings()).toHaveLength(0);
		// Even with the original timestamp, the correct metadata is new evidence.
		await post({ ...snapshot, lastMove: { from: "e2", to: "e4", san: "e4" } });
		expect(await h.until(() => ratings().length === 1, 2_000)).toBe(true);
		expect(ratings()[0]?.quality?.square).toBe("e4");
	});

	it("does not abort or replace foreground preparation when its arrival gains metadata", async () => {
		await start();
		h.transport.hold = true;
		await missing("e2e4");
		const session = h.session() as unknown as { pipelineAc: AbortController | null };
		expect(await h.until(() => session.pipelineAc !== null, 1_000)).toBe(true);
		const preparation = session.pipelineAc!;
		const commands = [...h.transport.sent];
		const cancel = spyOn(h.executor()!, "cancel");
		restores.push(() => cancel.mockRestore());
		await post(position(true));
		expect(session.pipelineAc).toBe(preparation);
		expect(preparation.signal.aborted).toBe(false);
		expect(h.transport.sent).toEqual(commands);
		expect(cancel).not.toHaveBeenCalled();
		h.transport.hold = false;
		await h.drive(() => h.transport.release());
		expect(await h.until(() => ratings().length === 1, 2_000)).toBe(true);
	});

	it("preserves an active executor plan when the opponent's lastMove arrives late", async () => {
		h = await createGameHarness({
			myColor: "b",
			timeControl: TC,
			settings: { automation: { autoMove: true, boardEffects: true, moveQualityChips: true } },
			head: {
				id: "chessmimic",
				median: () => 10,
				mean: () => 10,
				sample: () => ({ tSec: 10, mode: "normal", includesExecution: true, why: [] }),
			},
		});
		await h.arrive();
		await missing("e2e4");
		const executor = h.executor()!;
		expect(await h.until(() => executor.runningMove() !== null, 2_000)).toBe(true);
		const running = executor.runningMove()!;
		const rec = h.session().recommendation();
		const commands = [...h.transport.sent];
		const cancel = spyOn(executor, "cancel");
		const schedule = spyOn(executor, "schedule");
		restores.push(
			() => cancel.mockRestore(),
			() => schedule.mockRestore()
		);
		await post(position(true));
		expect(executor.runningMove()?.rec).toBe(running.rec);
		expect(executor.runningMove()?.plan).toBe(running.plan);
		expect(h.session().recommendation()).toBe(rec);
		expect(h.transport.sent).toEqual(commands);
		expect(cancel).not.toHaveBeenCalled();
		expect(schedule).not.toHaveBeenCalled();
	});

	it.each(["ply", "counter"] as const)(
		"refuses recovery when the replay does not match the %s",
		async (mismatch) => {
			await start();
			h.site.board.applyOpponent("e2e4");
			const snapshot = position(false);
			if (mismatch === "ply") snapshot.ply += 1;
			else snapshot.fen = snapshot.fen.replace(" 0 1", " 1 1");
			await post(snapshot);
			await post({ ...snapshot, lastMove: { from: "e2", to: "e4", san: "e4" } });
			await h.advance(1_000);
			expect(ratings()).toHaveLength(0);
		}
	);

	it("expires an unresolved arrival when another move lands", async () => {
		await start();
		const old = await missing("e2e4");
		await missing("e7e5");
		await post({ ...old, lastMove: { from: "e2", to: "e4", san: "e4" } });
		await h.advance(100);
		expect(ratings()).toHaveLength(0);
		await post(position(true));
		expect(await h.until(() => ratings().length === 1, 2_000)).toBe(true);
		expect(ratings()[0]?.quality?.square).toBe("e5");
	});

	it("does not resurrect old metadata after a game boundary", async () => {
		await start();
		const old = await missing("e2e4");
		await h.drive(() => h.site.startGame({ gameId: "next-game" }));
		await post({ ...old, gameId: "next-game" });
		await post({ ...old, gameId: "next-game", lastMove: { from: "e2", to: "e4", san: "e4" } });
		await h.advance(1_000);
		expect(ratings()).toHaveLength(0);
	});
});

it.each([false, true])(
	"recovers every skipped opening ply when history arrives late (game over: %s)",
	async (over) => {
		await start();
		for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6"]) h.site.board.applyOpponent(uci);
		const snapshot = position(false);
		await post(snapshot);
		if (over) await h.drive(() => h.site.endGame("1-0"));
		const playingCommands = [...h.transport.sent];
		const rec = h.session().recommendation();
		const state = h.session().currentState();
		const withHistory = { ...snapshot, moveHistory: ["e4", "e5", "Nf3", "Nc6"] };
		await post(withHistory); // same FEN, ply, timestamp and clocks
		expect(h.transport.sent).toEqual(playingCommands);
		expect(h.session().recommendation()).toBe(rec);
		expect(h.session().currentState()).toBe(state);
		const log = () => h.commands().filter((cmd) => cmd.kind === "moveListRating");
		expect(await h.until(() => log().length === 4, 10_000)).toBe(true);
		expect(
			log()
				.map((cmd) => cmd.rating)
				.sort((a, b) => a.ply - b.ply)
				.map(({ ply, san }) => [ply, san])
		).toEqual([
			[0, "e4"],
			[1, "e5"],
			[2, "Nf3"],
			[3, "Nc6"],
		]);
		expect(ratings()).toHaveLength(0);
		await post(withHistory);
		await h.advance(100);
		expect(log()).toHaveLength(4);
	}
);
