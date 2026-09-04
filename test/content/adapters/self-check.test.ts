// test/content/adapters/self-check.test.ts
import { describe, expect, it } from "bun:test";
import { SELECTORS } from "@content/adapters/selectors";
import { checkBoardSanity, checkGeometry, probeLadders } from "@content/adapters/self-check";
import { createTabDom } from "@test/sim/dom/tab-dom";
import { BOARD_RECT, loadFixture, pageDocument, q } from "./helpers";

describe("checkBoardSanity", () => {
	it("accepts a legal-looking placement", () => {
		expect(checkBoardSanity("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR").ok).toBe(true);
	});
	it("rejects missing/duplicate kings and out-of-range piece counts", () => {
		expect(checkBoardSanity("rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR").ok).toBe(false);
		expect(checkBoardSanity("rnbqkknr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR").ok).toBe(false);
		expect(checkBoardSanity("8/8/8/8/8/8/8/K7").ok).toBe(false);
		expect(checkBoardSanity(null).ok).toBe(false);
	});
});

describe("probeLadders", () => {
	it("reports the matched index per concern and lists the misses", () => {
		const dom = loadFixture("chesscom-computer");
		const report = probeLadders(
			{ board: SELECTORS.chesscom.board, clockTime: SELECTORS.chesscom.clockTime },
			pageDocument(dom)
		);
		expect(report.matched).toEqual([
			{ concern: "board", index: 1, selector: "wc-chess-board#board-play-computer" },
		]);
		expect(report.misses).toEqual(["clockTime"]);
	});
});

describe("checkGeometry", () => {
	it("passes when the square centre hits the board and round-trips", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML('<wc-chess-board id="board-single"></wc-chess-board>');
		dom.layout("wc-chess-board", BOARD_RECT);
		const board = q(dom, "wc-chess-board");
		expect(checkGeometry(board, BOARD_RECT, false, pageDocument(dom)).ok).toBe(true);
		dom.clearLayout();
		dom.layout("wc-chess-board", { x: 900, y: 900, width: 528, height: 528 });
		expect(checkGeometry(board, BOARD_RECT, false, pageDocument(dom)).ok).toBe(false);
	});
});
