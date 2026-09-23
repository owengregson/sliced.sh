// test/core/tablebase/probe.test.ts — the API's JSON is untrusted: validated, never thrown on.
import { describe, expect, it } from "bun:test";
import { inTablebaseRange, parseProbe, pieceCount, probeFen } from "@core/tablebase/probe";
import { apiAnswer, apiMove, KRK_WIN, KRK_WIN_FEN } from "./fixtures";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("parseProbe", () => {
	it("reads a real answer", () => {
		const probe = parseProbe(KRK_WIN);
		expect(probe?.category).toBe("win");
		expect(probe?.moves).toHaveLength(22);
		expect(probe?.moves[0]).toEqual({
			uci: "c2c3",
			category: "loss",
			dtz: -24,
			preciseDtz: true,
			dtm: -24,
			zeroing: false,
			checkmate: false,
			stalemate: false,
		});
	});

	it("prefers the precise distance and marks a rounded one", () => {
		const probe = parseProbe(
			apiAnswer("win", [
				apiMove("h1h5", "loss", -26, { precise_dtz: -25 }),
				apiMove("h1h4", "loss", -26, { precise_dtz: null }),
			])
		);
		expect(probe?.moves.map((m) => [m.dtz, m.preciseDtz])).toEqual([
			[-25, true],
			[-26, false],
		]);
	});

	it("drops malformed moves and rejects malformed answers", () => {
		const probe = parseProbe(
			apiAnswer("win", [
				apiMove("h1h5", "loss", -26),
				apiMove("h1h9", "loss", -26),
				apiMove("h1h4", "victory", -26),
				{ uci: 42 },
				null as never,
			])
		);
		expect(probe?.moves.map((m) => m.uci)).toEqual(["h1h5"]);
		expect(parseProbe(null)).toBeNull();
		expect(parseProbe("win")).toBeNull();
		expect(parseProbe({ category: "win" })).toBeNull();
		expect(parseProbe({ category: "sure-win", moves: [] })).toBeNull();
	});

	it("treats a non-integer distance as unknown", () => {
		const probe = parseProbe(
			apiAnswer("win", [apiMove("h1h5", "loss", -26, { precise_dtz: 1.5, dtm: "3" as never })])
		);
		expect(probe?.moves[0]?.dtz).toBe(-26);
		expect(probe?.moves[0]?.dtm).toBeNull();
	});
});

describe("range and identity", () => {
	it("counts men, kings included", () => {
		expect(pieceCount(KRK_WIN_FEN)).toBe(3);
		expect(pieceCount(START)).toBe(32);
		expect(pieceCount("")).toBeNull();
	});

	it("answers only legal positions of at most seven men", () => {
		expect(inTablebaseRange(KRK_WIN_FEN)).toBe(true);
		expect(inTablebaseRange("4k3/pppp4/8/8/8/8/PPP5/4K3 w - - 0 1")).toBe(false);
		expect(inTablebaseRange("4k3/ppp5/8/8/8/8/PP6/4K3 w - - 0 1")).toBe(true);
		expect(inTablebaseRange(START)).toBe(false);
	});

	it("probes without the counters, so one request answers every visit", () => {
		expect(probeFen("8/8/8/4k3/8/8/2K5/7R w - - 37 80")).toBe("8/8/8/4k3/8/8/2K5/7R w - - 0 1");
		expect(probeFen("not a fen")).toBeNull();
	});
});
