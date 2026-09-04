// test/content/adapters/query.test.ts
import { describe, expect, it } from "bun:test";
import { queryAllFirst, queryFirst, queryFirstElement } from "@content/adapters/query";
import { createTabDom } from "@test/sim/dom/tab-dom";
import { pageDocument } from "./helpers";

describe("queryFirst", () => {
	it("returns the first candidate that matches with its index", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML('<div class="b"></div><div id="x"></div>');
		const hit = queryFirst(["#nope", ".b", "#x"], pageDocument(dom));
		expect(hit?.index).toBe(1);
		expect(hit?.element.className).toBe("b");
		expect(queryFirst(["#nope", ".zzz"], pageDocument(dom))).toBeNull();
		expect(queryFirstElement(["#x"], pageDocument(dom))?.id).toBe("x");
	});
	it("queryAllFirst returns every match of the first matching candidate", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML('<i class="n"></i><i class="n"></i><b class="m"></b>');
		const hit = queryAllFirst([".zzz", ".n", ".m"], pageDocument(dom));
		expect(hit?.index).toBe(1);
		expect(hit?.elements.length).toBe(2);
		expect(queryAllFirst([".zzz"], pageDocument(dom))).toBeNull();
	});
	it("tolerates invalid selectors in a ladder", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML('<div id="x"></div>');
		expect(queryFirst(["[[bad", "#x"], pageDocument(dom))?.index).toBe(1);
	});
});
