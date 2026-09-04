// test/content/adapters/move-list.test.ts
import { describe, expect, it } from "bun:test";
import {
	findLichessRoundMoves,
	normalizeSan,
	readChesscomMoveList,
	readLichessMoveList,
	sanFromChesscomNode,
} from "@content/adapters/move-list";
import { createTabDom } from "@test/sim/dom/tab-dom";
import { loadFixture, pageDocument, q } from "./helpers";

describe("chess.com move list", () => {
	it("returns the main line as SAN with figurine handling and the selected index", () => {
		const dom = loadFixture("chesscom-live");
		const list = readChesscomMoveList(pageDocument(dom));
		expect(list.sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
		expect(list.selectedIndex).toBe(5);
		expect(list.result).toBeNull();
	});
	it("reads the result row on a finished game", () => {
		const dom = loadFixture("chesscom-gameover");
		const list = readChesscomMoveList(pageDocument(dom));
		expect(list.sans).toEqual(["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]);
		expect(list.selectedIndex).toBe(6);
		expect(list.result).toBe("1-0");
	});
	it("maps unicode figurines and strips annotations", () => {
		expect(normalizeSan("♘f3 ")).toBe("Nf3");
		expect(normalizeSan("♛xd5?!")).toBe("Qxd5");
		expect(normalizeSan("O-O-O+")).toBe("O-O-O+");
		expect(normalizeSan("0-0")).toBe("O-O");
		expect(normalizeSan("e8=♕#")).toBe("e8=Q#");
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML(
			'<div class="node main-line-ply"><span class="node-highlight-content"><span data-figurine="B"></span>b5 </span></div>'
		);
		expect(sanFromChesscomNode(q(dom, ".node"))).toBe("Bb5");
	});
	it("is empty without a move list", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML("<div></div>");
		expect(readChesscomMoveList(pageDocument(dom))).toEqual({
			sans: [],
			selectedIndex: -1,
			result: null,
		});
	});
});

describe("findLichessRoundMoves (structural detector)", () => {
	it("finds the container on the 2026-07 rotated tags", () => {
		const dom = loadFixture("lichess-round-white");
		const found = findLichessRoundMoves(pageDocument(dom));
		expect(found?.container.tagName).toBe("APP");
		expect(found?.moves.map((m) => m.textContent?.trim())).toEqual(["e4", "e5", "Nf3", "Nc6"]);
		expect(found?.moveTag).toBe("Z7YX");
		expect(found?.indexTag).toBe("QZM");
		expect(found ? found.index(found.moves[3] as Element) : -1).toBe(3);
	});
	it("finds the container on a fixture with tag names in no ladder", () => {
		const dom = loadFixture("lichess-round-black");
		const found = findLichessRoundMoves(pageDocument(dom));
		expect(found?.moves.map((m) => m.textContent?.trim())).toEqual(["d4", "d5", "c4"]);
		expect(found?.moveTag).toBe("M3ZK");
		expect(found?.indexTag).toBe("Q9AB");
	});
	it("works on a synthetic fixture with yet other tags and ignores placeholders", () => {
		const dom = createTabDom("https://lichess.org/abcdefgh");
		dom.setHTML(
			'<main class="round"><div class="round__app"><zz1><y9><button>x</button></y9>' +
				'<w2><n0>12</n0><mv>…</mv><mv>Nf6</mv><n0>13</n0><mv class="cur">d4</mv></w2></zz1></div></main>'
		);
		const found = findLichessRoundMoves(pageDocument(dom));
		expect(found?.container.tagName).toBe("W2");
		expect(found?.moves.map((m) => m.textContent)).toEqual(["Nf6", "d4"]);
		const list = readLichessMoveList(pageDocument(dom));
		expect(list.sans).toEqual(["Nf6", "d4"]);
		expect(list.activeIndex).toBe(1);
		expect(list.firstPly).toBe(23);
	});
	it("returns null when there is no round app", () => {
		const dom = createTabDom("https://lichess.org/");
		dom.setHTML("<main></main>");
		expect(findLichessRoundMoves(pageDocument(dom))).toBeNull();
	});
});

describe("readLichessMoveList", () => {
	it("reads SAN, the active index and the result", () => {
		const dom = loadFixture("lichess-round-black");
		const list = readLichessMoveList(pageDocument(dom));
		expect(list.sans).toEqual(["d4", "d5", "c4"]);
		expect(list.activeIndex).toBe(2);
		expect(list.firstPly).toBe(0);
		expect(list.result).toBeNull();
		const container = findLichessRoundMoves(pageDocument(dom))?.container.parentElement as Element;
		container.insertAdjacentHTML(
			"beforeend",
			'<div class="result-wrap"><p class="result">½-½</p><p class="status">Draw by agreement</p></div>'
		);
		expect(readLichessMoveList(pageDocument(dom)).result).toBe("1/2-1/2");
	});
});
