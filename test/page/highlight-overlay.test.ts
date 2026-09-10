// test/page/highlight-overlay.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { bindCode, emit } from "@pagescript";
import { highlightOverlay } from "../../src/page/highlight-overlay";
import { OVERLAY_COLORS } from "../../src/page/index";
import {
	command,
	forbiddenIn,
	makeWindow,
	type Posted,
	recordPosts,
	runProgram,
	SEED,
	sendToPage,
	TOKENS_FOR_SEED,
} from "./helpers";

const emitted = emit(highlightOverlay, { seed: SEED });
const { key, page, overlayClass } = TOKENS_FOR_SEED;
const bound = bindCode(emitted.code, emitted.params, {
	token: page,
	peer: TOKENS_FOR_SEED.content,
	hosts: ["cg-container", "wc-chess-board"],
	cls: overlayClass,
	colors: OVERLAY_COLORS,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function boot(html: string) {
	const win = makeWindow("https://www.chess.com/game/174252011111");
	cleanups.push(() => win.happyDOM.close());
	win.document.body.innerHTML = html;
	const rec = recordPosts(win);
	cleanups.push(rec.restore);
	const keysBefore = Object.keys(win);
	runProgram(bound, win);
	return { win, posts: rec.posts, keysBefore };
}

function reply(posts: Posted[], id: string): Record<string, unknown> | undefined {
	return posts.find((p) => p.data[key] === page && p.data.i === id)?.data;
}

describe("highlight-overlay", () => {
	it("emits no forbidden substring and no literal host selector / colour / class", () => {
		expect(forbiddenIn(emitted.code)).toEqual([]);
		expect(emitted.code).not.toContain("cg-container");
		expect(emitted.code).not.toContain(OVERLAY_COLORS.from);
		expect(emitted.code).not.toContain(overlayClass);
		expect(emitted.code).not.toContain("defineOnce");
		expect(emitted.code).not.toMatch(/window\.\w+\s*=/);
	});
	it("inserts nothing until draw, then one svg with pointer-events none; evaluating twice is idempotent", () => {
		const { win, posts, keysBefore } = boot("<cg-container><cg-board></cg-board></cg-container>");
		expect(Object.keys(win)).toEqual(keysBefore);
		expect(win.document.querySelectorAll("svg")).toHaveLength(0);
		runProgram(bound, win); // second evaluation: still nothing inserted
		sendToPage(
			win,
			command("draw", "1", { r: "w", h: [{ q: "d2" }, { q: "d4" }], a: [{ f: "g1", t: "f3" }] })
		);
		// both listeners drew into the same element: still exactly one overlay
		const svgs = win.document.querySelectorAll(`cg-container > svg.${overlayClass}`);
		expect(svgs).toHaveLength(1);
		expect(svgs[0]?.getAttribute("style")).toContain("pointer-events:none");
		const rects = svgs[0]?.querySelectorAll("rect") ?? [];
		expect(rects[0]?.getAttribute("fill")).toBe(OVERLAY_COLORS.from); // fallback colours from TOKENS
		expect(rects[1]?.getAttribute("fill")).toBe(OVERLAY_COLORS.to);
		expect(svgs[0]?.querySelector("polygon")?.getAttribute("fill")).toBe(OVERLAY_COLORS.arrow);
		expect(reply(posts, "1")?.p).toEqual({ y: [] });
		sendToPage(win, command("clear", "2"));
		expect(win.document.querySelectorAll("svg")).toHaveLength(0);
	});
	it("uses the wc-chess-board host on chess.com markup and draws nothing without a host", () => {
		const a = boot('<wc-chess-board id="board-single"></wc-chess-board>');
		sendToPage(a.win, command("draw", "1", { r: "w", h: [{ q: "a1" }], a: [] }));
		expect(a.win.document.querySelector(`wc-chess-board > svg.${overlayClass}`)).not.toBeNull();
		const b = boot("<div></div>");
		sendToPage(b.win, command("draw", "1", { r: "w", h: [{ q: "a1" }], a: [] }));
		expect(b.win.document.querySelectorAll("svg")).toHaveLength(0);
		expect(reply(b.posts, "1")).toBeDefined();
	});
	it("arrow polygon points are finite numbers pointing from the origin square to the destination", () => {
		const { win } = boot("<cg-container></cg-container>");
		sendToPage(win, command("draw", "1", { r: "w", h: [], a: [{ f: "a1", t: "a8" }] }));
		const pts = (win.document.querySelector("polygon")?.getAttribute("points") ?? "")
			.split(" ")
			.map((p) => p.split(",").map(Number));
		expect(pts).toHaveLength(7);
		for (const [x, y] of pts) {
			expect(Number.isFinite(x)).toBe(true);
			expect(Number.isFinite(y)).toBe(true);
		}
		// tip is the centre of a8 (col 0, row 0)
		expect(pts[3]).toEqual([0.5, 0.5]);
		// shaft starts below (larger y) the tip, inside the a-file
		expect(pts[0]?.[1]).toBeGreaterThan(6);
	});
});
