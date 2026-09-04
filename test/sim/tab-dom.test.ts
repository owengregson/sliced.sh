// test/sim/tab-dom.test.ts
import { describe, expect, it } from "bun:test";
import { createTabDom, installWindowGlobals } from "@test/sim/dom/tab-dom";

describe("tab DOM", () => {
	it("hosts a page with the tab url and basic helpers", () => {
		const dom = createTabDom("https://www.chess.com/play/online");
		expect(dom.window.location.href).toBe("https://www.chess.com/play/online");
		dom.setHTML("<input id='i' value='abc'><div id='d'>hello</div><textarea id='t'>x</textarea>");
		expect(dom.text("#i")).toBe("abc");
		expect(dom.text("#d")).toBe("hello");
		expect(dom.text("#t")).toBe("x");
		dom.focus("#t");
		expect(dom.document.activeElement?.id).toBe("t");
		expect(() => dom.query("#nope")).toThrow(/no element matches/);
	});

	it("layout() drives elementFromPoint / getBoundingClientRect; later rectangles are on top", () => {
		const dom = createTabDom("https://www.chess.com/");
		dom.setHTML("<div id='board'><div class='sq' id='e2'></div><div class='sq' id='e4'></div></div>");
		dom.layout("#board", { x: 100, y: 100, width: 400, height: 400 });
		dom.layout("#e2", { x: 300, y: 400, width: 50, height: 50 });
		dom.layout("#e4", { x: 300, y: 300, width: 50, height: 50 });
		expect(dom.elementAt(325, 425)?.id).toBe("e2");
		expect(dom.elementAt(325, 325)?.id).toBe("e4");
		expect(dom.elementAt(110, 110)?.id).toBe("board");
		expect(dom.elementAt(5, 5)).toBeNull();
		expect(dom.document.elementFromPoint(325, 425)?.id).toBe("e2");
		const doc = dom.document as unknown as {
			elementsFromPoint(x: number, y: number): { id: string }[];
		};
		expect(doc.elementsFromPoint(325, 425).map((e) => e.id)).toEqual(["e2", "board"]);
		const rect = dom.query("#e4").getBoundingClientRect();
		expect([rect.x, rect.y, rect.width, rect.height]).toEqual([300, 300, 50, 50]);
		expect(dom.rectOf(dom.query("#e2"))).toEqual({ x: 300, y: 400, width: 50, height: 50 });
		dom.setHTML("<p></p>"); // detached elements no longer hit
		expect(dom.elementAt(325, 425)).toBeNull();
		dom.clearLayout();
	});

	it("installWindowGlobals exposes window/document/constructors and restores them", () => {
		const dom = createTabDom("https://lichess.org/");
		const g = globalThis as Record<string, unknown>;
		const hadWindow = "window" in g;
		const restore = installWindowGlobals(dom.window);
		expect(g.window).toBe(dom.window);
		expect(g.document).toBe(dom.document);
		expect(g.Element).toBe(dom.window.Element);
		expect((g.location as { href: string }).href).toBe("https://lichess.org/");
		restore();
		expect("window" in g).toBe(hadWindow);
	});
});
