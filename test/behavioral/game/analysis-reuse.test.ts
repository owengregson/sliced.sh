// test/behavioral/game/analysis-reuse.test.ts — §6.4 / Appendix E §4.5 end to end: a position this
// session has already analysed comes back from the `AnalysisCache` instead of being searched again,
// so the move is available immediately. Until this lane the cache was unreachable on the paths it
// exists for: `fenKey` kept the en-passant field, which three FEN sources spell differently, and a
// hit had to match the requested `depthCap` exactly, which a `movetime` search never does.
import { afterEach, describe, expect, it } from "bun:test";
import type { PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const BULLET = { baseMs: 60_000, incMs: 0 };
/**
 * The position after 1.e4, in the two spellings that reach the session for the **same ply**.
 *
 * `ChessComAdapter.positionInfoFor` answers from the MAIN-world bridge when it has one and from a
 * chess.js replay of the move list when it does not — and those disagree after every double push:
 * chess.com's `game.getFEN()` names the en-passant square, a chess.js replay drops one no pawn can
 * use. The live page delivers both in order, because the first readable snapshot is taken before
 * the bridge has answered anything and the bridge's answer then republishes the unmoved ply
 * (together with the colour and the time control). The simulated board can only produce the
 * chess.js spelling, which is why these are posted by hand: the fixture was hiding the divergence.
 */
const REPLAY_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const BRIDGE_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

/** Own-move searches the engine was actually asked for (`go infinite` ponders excluded). */
const moveSearches = (harness: GameHarness): number =>
	harness.transport.goLines.filter((l) => l.includes("movetime")).length;

function snapshotOf(harness: GameHarness, fen: string, timed: boolean): PositionSnapshot {
	const snapshot: PositionSnapshot = {
		site: "chesscom",
		gameId: harness.site.gameId,
		fen,
		ply: 1,
		sideToMove: "b",
		myColor: "b",
		clocks: {
			w: { ms: BULLET.baseMs, running: false },
			b: { ms: BULLET.baseMs, running: true },
		},
		capturedAt: harness.sim.now(),
	};
	if (timed) snapshot.timeControl = BULLET;
	return snapshot;
}

describe("game session: an analysed position is not searched twice", () => {
	it("the bridge's spelling of a ply already analysed from the replay spelling hits the cache", async () => {
		h = await createGameHarness({
			timeControl: null,
			myColor: "b",
			gameId: "reuse-spelling",
			settings: { automation: { autoMove: false } },
		});
		// Ply 1 as the replay spells it (no bridge answer yet): one search, cached under that key.
		await h.drive(() =>
			h.site.post({ kind: "position", snapshot: snapshotOf(h, REPLAY_FEN, false) })
		);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const first = moveSearches(h);
		expect(first).toBe(1);
		expect(h.session().recommendation()?.plan.features.tc_untimed).toBe(1);

		// The bridge answers: the same ply, chess.com's own spelling, and now with the clock. The
		// session must re-run the pipeline (the class and the preset changed) — and must not search.
		await h.drive(() => h.site.post({ kind: "position", snapshot: snapshotOf(h, BRIDGE_FEN, true) }));
		expect(
			await h.until(() => h.session().recommendation()?.plan.features.tc_bullet === 1, 10_000)
		).toBe(true);
		expect(h.session().recommendation()?.fen).toBe(BRIDGE_FEN);
		expect(h.session().recommendation()?.chosen.uci.length).toBe(4);
		expect(moveSearches(h)).toBe(first);
	}, 60_000);
});
