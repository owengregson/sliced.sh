// test/page/parts.test.ts
import { describe, expect, it } from "bun:test";
import { defineProgram, type Expression, emit, js, type Statement } from "@pagescript";
import { joined, n, s } from "../../src/page/parts/ast";
import { hostLadder, layerFind, squareCell } from "../../src/page/parts/layer";
import { canAnimate, prefersReducedMotion } from "../../src/page/parts/motion";
import { setAttr, svgEl } from "../../src/page/parts/svg";

function code(body: Statement[]): string {
	return emit(defineProgram({ name: "parts", params: {}, build: () => js.program(body) }), {
		seed: "parts",
	}).code;
}

const exprCode = (e: Expression): string => code([js.expr(e)]);

describe("page parts", () => {
	it("squareCell maps squares to on-screen cells for either orientation", () => {
		const cell = new Function(`${code([squareCell("cell")])} return cell;`)() as (
			sq: string,
			black: boolean
		) => [number, number];
		expect(cell("a1", false)).toEqual([0, 7]);
		expect(cell("h8", false)).toEqual([7, 0]);
		expect(cell("a1", true)).toEqual([7, 0]);
		expect(cell("e2", true)).toEqual([3, 1]);
	});

	it("hostLadder returns the first selector that matches, and layerFind looks inside it", () => {
		const layer = { tag: "layer" };
		const host = { querySelector: (sel: string) => (sel === ".c" ? layer : null) };
		const document = { querySelector: (sel: string) => (sel === "b" ? host : null) };
		const find = new Function(
			"document",
			`${code([hostLadder("ladder", js.arr(s("a"), s("b")), "each"), layerFind("find", "ladder", s("c"))])} return find;`
		)(document) as () => unknown;
		expect(find()).toBe(layer);
	});

	it("reads the reduced-motion preference the one way every layer reads it", () => {
		expect(exprCode(prefersReducedMotion(s("q")))).toBe(
			'window.matchMedia && window.matchMedia("q").matches;'
		);
		expect(exprCode(canAnimate(js.id("el"), s("q")))).toBe(
			'typeof el.animate === "function" && !(window.matchMedia && window.matchMedia("q").matches);'
		);
	});

	it("builds SVG nodes and attributes", () => {
		expect(code([js.const_("g", svgEl("g")), setAttr(js.id("g"), "x", n(1))])).toBe(
			'const g = document.createElementNS("http://www.w3.org/2000/svg", "g");g.setAttribute("x", 1);'
		);
	});

	it("joins string parts, the empty list being the empty string", () => {
		expect(exprCode(joined([]))).toBe('"";');
		expect(exprCode(joined([s("a"), js.id("b"), s("c")]))).toBe('"a" + b + "c";');
	});
});
