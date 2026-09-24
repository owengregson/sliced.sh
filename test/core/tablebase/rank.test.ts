// test/core/tablebase/rank.test.ts — perfect play from a probe against the game's own counters:
// fastest conversion inside the 50-move rule, longest resistance, repetition, legality.
import { describe, expect, it } from "bun:test";
import { parseProbe, type TablebaseProbe } from "@core/tablebase/probe";
import { keepsResult, rankTablebaseMoves } from "@core/tablebase/rank";
import { apiAnswer, apiMove, KRK_LOSS, KRK_LOSS_FEN, KRK_WIN, KRK_WIN_FEN } from "./fixtures";

function probe(json: Record<string, unknown>): TablebaseProbe {
	const p = parseProbe(json);
	if (!p) throw new Error("fixture does not parse");
	return p;
}

/** `fen` with its half-move clock replaced. */
function withClock(fen: string, clock: number): string {
	const f = fen.split(" ");
	f[4] = String(clock);
	return f.join(" ");
}

describe("rankTablebaseMoves", () => {
	it("wins by the fastest conversion, the shorter mate breaking a tie", () => {
		const answer = rankTablebaseMoves({ fen: KRK_WIN_FEN, probe: probe(KRK_WIN) });
		expect(answer?.outcome).toBe("win");
		expect(answer?.best.uci).toBe("c2c3");
		expect(answer?.best.zeroingPlies).toBe(25);
		expect(answer?.ranked.at(-1)?.uci).toBe("c2b1");
		expect(answer?.ranked).toHaveLength(22);
	});

	it("lets the engine choose between moves the tables rank equal", () => {
		const answer = rankTablebaseMoves({
			fen: KRK_WIN_FEN,
			probe: probe(KRK_WIN),
			enginePreference: ["h1h5", "c2d3", "c2c3"],
		});
		expect(answer?.best.uci).toBe("c2d3");
	});

	it("counts the game's half-move clock: a win that zeroes too late is a cursed win", () => {
		// 70 + 1 + 24 = 95 plies: still inside the rule; c2b1 (71 + 30 = 101) is not.
		const inTime = rankTablebaseMoves({ fen: withClock(KRK_WIN_FEN, 70), probe: probe(KRK_WIN) });
		expect(inTime?.outcome).toBe("win");
		expect(inTime?.ranked.find((m) => m.uci === "c2b1")?.outcome).toBe("cursed-win");
		// 80 + 1 + 24 = 105: every move is drawn by the rule.
		const late = rankTablebaseMoves({ fen: withClock(KRK_WIN_FEN, 80), probe: probe(KRK_WIN) });
		expect(late?.outcome).toBe("cursed-win");
		// A clock at 99 draws on any quiet move.
		const drawn = rankTablebaseMoves({ fen: withClock(KRK_WIN_FEN, 99), probe: probe(KRK_WIN) });
		expect(drawn?.outcome).toBe("draw");
	});

	it("keeps a ply of margin from the rule when the table's distance is rounded", () => {
		const rounded = apiAnswer("win", [apiMove("h1h5", "loss", -26, { precise_dtz: null })]);
		// 73 + 1 + 26 = 100: exactly on the limit — a win when exact, a cursed win when rounded.
		const exact = rankTablebaseMoves({
			fen: withClock(KRK_WIN_FEN, 73),
			probe: probe(apiAnswer("win", [apiMove("h1h5", "loss", -26)])),
		});
		expect(exact?.outcome).toBe("win");
		const margin = rankTablebaseMoves({ fen: withClock(KRK_WIN_FEN, 73), probe: probe(rounded) });
		expect(margin?.outcome).toBe("cursed-win");
	});

	it("resists a loss as long as possible", () => {
		const answer = rankTablebaseMoves({ fen: KRK_LOSS_FEN, probe: probe(KRK_LOSS) });
		expect(answer?.outcome).toBe("loss");
		expect(answer?.best.uci).toBe("c3d4");
		expect(answer?.best.zeroingPlies).toBe(30);
	});

	it("finds the 50-move draw inside a lost position", () => {
		// 72 + 1 + 29 = 102 > 100: the winner cannot zero in time after c3d4; c3c4 reaches 100.
		const answer = rankTablebaseMoves({ fen: withClock(KRK_LOSS_FEN, 72), probe: probe(KRK_LOSS) });
		expect(answer?.outcome).toBe("blessed-loss");
		expect(answer?.best.uci).toBe("c3d4");
		expect(answer?.ranked.find((m) => m.uci === "c3c4")?.outcome).toBe("loss");
	});

	it("plays checkmate first", () => {
		const fen = "k7/8/1K6/8/8/8/8/7R w - - 0 1";
		const answer = rankTablebaseMoves({
			fen,
			probe: probe(
				apiAnswer("win", [
					apiMove("h1h7", "loss", -2, { dtm: -2 }),
					apiMove("h1h8", "loss", 0, { dtm: 0, checkmate: true }),
				])
			),
		});
		expect(answer?.best.uci).toBe("h1h8");
		expect(answer?.best.checkmate).toBe(true);
	});

	it("never returns a move the board does not allow", () => {
		const illegal = probe(
			apiAnswer("win", [apiMove("a1a2", "loss", -3), apiMove("h1h5", "loss", -26)])
		);
		expect(
			rankTablebaseMoves({ fen: KRK_WIN_FEN, probe: illegal })?.ranked.map((m) => m.uci)
		).toEqual(["h1h5"]);
		const onlyIllegal = probe(apiAnswer("win", [apiMove("a1a2", "loss", -3)]));
		expect(rankTablebaseMoves({ fen: KRK_WIN_FEN, probe: onlyIllegal })).toBeNull();
	});

	it("returns nothing when every move is unknown", () => {
		const unknown = probe(apiAnswer("unknown", [apiMove("h1h5", "unknown", null)]));
		expect(rankTablebaseMoves({ fen: KRK_WIN_FEN, probe: unknown })).toBeNull();
	});

	it("treats a move completing a threefold repetition as the draw it is", () => {
		const cycle = ["c2d2", "e5e4", "d2c2", "e4e5"];
		const history = { fen: KRK_WIN_FEN, moves: [...cycle, ...cycle] };
		const fen = "8/8/8/4k3/8/8/2K5/7R w - - 8 5";
		const answer = rankTablebaseMoves({ fen, probe: probe(KRK_WIN), history });
		const repeat = answer?.ranked.find((m) => m.uci === "c2d2");
		expect(repeat?.outcome).toBe("draw");
		expect(answer?.best.outcome).toBe("win");
		expect(answer?.best.uci).not.toBe("c2d2");
	});

	it("reads the half-move clock from the replayed history over the FEN's counters", () => {
		const cycle = ["c2d2", "e5e4", "d2c2", "e4e5"];
		// A DOM-read FEN claims clock 0; the history says 4.
		const fen = "8/8/8/4k3/8/8/2K5/7R w - - 0 3";
		const answer = rankTablebaseMoves({
			fen,
			probe: probe(apiAnswer("win", [apiMove("h1h5", "loss", -96)])),
			history: { fen: KRK_WIN_FEN, moves: cycle },
		});
		// 4 + 1 + 96 = 101: drawn by the rule, although the FEN's clock (0 + 1 + 96) would say won.
		expect(answer?.outcome).toBe("cursed-win");
	});

	it("keeps a draw by the engine's preference and ranks a cursed win above it", () => {
		const draws = probe(
			apiAnswer("draw", [
				apiMove("h1a1", "draw", 0),
				apiMove("h1h5", "draw", 0),
				apiMove("c2c3", "win", 10),
			])
		);
		const answer = rankTablebaseMoves({ fen: KRK_WIN_FEN, probe: draws, enginePreference: ["h1h5"] });
		expect(answer?.best.uci).toBe("h1h5");
		expect(answer?.ranked.at(-1)?.outcome).toBe("loss");
		const cursed = probe(
			apiAnswer("cursed-win", [apiMove("h1a1", "draw", 0), apiMove("h1h5", "blessed-loss", -120)])
		);
		expect(rankTablebaseMoves({ fen: KRK_WIN_FEN, probe: cursed })?.best.uci).toBe("h1h5");
	});
});

describe("keepsResult", () => {
	it("tells a result-keeping move from a throw", () => {
		const answer = rankTablebaseMoves({
			fen: KRK_WIN_FEN,
			probe: probe(apiAnswer("win", [apiMove("h1h5", "loss", -26), apiMove("h1a1", "draw", 0)])),
		});
		if (!answer) throw new Error("no answer");
		expect(keepsResult(answer, "h1h5")).toBe(true);
		expect(keepsResult(answer, "h1a1")).toBe(false);
		expect(keepsResult(answer, "c2c3")).toBe(false);
	});
});
