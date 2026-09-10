// test/content/adapters/dom-fen.test.ts
import { describe, expect, it } from "bun:test";
import {
	approximateFen,
	placementFromDom,
	placementOf,
	replayFen,
} from "@content/adapters/dom-fen";
import { loadFixture, pageDocument, q } from "./helpers";

const LIVE = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R";
const MATE = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR";
const WHITE4 = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R";

describe("placementFromDom", () => {
	it("reads .piece square-XY classes in any order", () => {
		const dom = loadFixture("chesscom-live");
		expect(placementFromDom(q(dom, "wc-chess-board"))).toBe(LIVE);
		const over = loadFixture("chesscom-gameover");
		expect(placementFromDom(q(over, "wc-chess-board"))).toBe(MATE);
	});
	it("returns null on a duplicate square (mid-animation) or too few pieces", () => {
		const dom = loadFixture("chesscom-live");
		const board = q(dom, "wc-chess-board");
		const extra = pageDocument(dom).createElement("div");
		extra.className = "piece wq square-11";
		board.appendChild(extra);
		expect(placementFromDom(board)).toBeNull();
		dom.setHTML('<wc-chess-board><div class="piece wk square-51"></div></wc-chess-board>');
		expect(placementFromDom(q(dom, "wc-chess-board"))).toBeNull();
	});
});

describe("replayFen / placementOf / approximateFen", () => {
	it("replays SAN through chess.js", () => {
		const fen = replayFen(["e4", "e5", "Nf3", "Nc6"]);
		expect(fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
		expect(placementOf(fen ?? "")).toBe(WHITE4);
		expect(replayFen(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"])).toBe(
			"r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4"
		);
		expect(replayFen(["e4", "e9"])).toBeNull();
		expect(replayFen(["e4", "e5", "Nf3", "Nc6"], "8/8/8/8/8/8/8/8 w - - 0 1")).toBeNull();
	});
	it("derives castling rights from home squares and ep from a pawn double-step", () => {
		expect(approximateFen(WHITE4, "w", { fullmove: 3 })).toBe(`${WHITE4} w KQkq - 0 3`);
		expect(approximateFen(MATE, "b", { fullmove: 4 })).toBe(`${MATE} b KQkq - 0 4`);
		expect(approximateFen(LIVE, "w", { fullmove: 4, lastMove: { from: "a7", to: "a6" } })).toBe(
			`${LIVE} w KQkq - 0 4`
		);
		const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR";
		expect(approximateFen(afterE4, "b", { fullmove: 1, lastMove: { from: "e2", to: "e4" } })).toBe(
			`${afterE4} b KQkq e3 0 1`
		);
		expect(approximateFen("4k3/8/8/8/8/8/8/4K2R", "w", { fullmove: 30 })).toBe(
			"4k3/8/8/8/8/8/8/4K2R w K - 0 30"
		);
	});
});
