// test/content/adapters/move-list.test.ts
import { describe, expect, it } from "bun:test";
import { normalizeSan, readMoveList, sanFromMoveNode } from "@content/adapters/move-list";
import { createTabDom } from "@test/sim/dom/tab-dom";
import { loadFixture, pageDocument, q } from "./helpers";

describe("chess.com move list", () => {
	it("returns the main line as SAN with figurine handling and the selected index", () => {
		const dom = loadFixture("chesscom-live");
		const list = readMoveList(pageDocument(dom));
		expect(list.sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
		expect(list.selectedIndex).toBe(5);
		expect(list.result).toBeNull();
	});
	it("reads the result row on a finished game", () => {
		const dom = loadFixture("chesscom-gameover");
		const list = readMoveList(pageDocument(dom));
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
		expect(sanFromMoveNode(q(dom, ".node"))).toBe("Bb5");
	});
	it("is empty without a move list", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML("<div></div>");
		expect(readMoveList(pageDocument(dom))).toEqual({
			sans: [],
			selectedIndex: -1,
			result: null,
		});
	});
});
