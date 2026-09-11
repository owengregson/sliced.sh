// test/page/virtual-cursor.test.ts — Fix D: the MAIN-world pointer mirror.
//
// The §13.3 rule 3 presence rules are the whole point of these tests: nothing is inserted until a
// position arrives, the element is found by its per-build class (not a `window` property, not an
// `id`), a second position redraws the same element rather than appending another, and `cursorHide`
// removes it. The graphic itself is checked only for what §13.3 constrains — no forbidden word, no
// stable identifier, `pointer-events: none` — plus the two things that make it readable as a
// pointer: the hotspot offset and the press feedback.
import { afterEach, describe, expect, it } from "bun:test";
import { TIMINGS } from "@core/constants/timings";
import { bindCode, emit } from "@pagescript";
import { CURSOR_ART, virtualCursor } from "../../src/page/virtual-cursor";
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

const emitted = emit(virtualCursor, { seed: SEED });
const { cursorClass } = TOKENS_FOR_SEED;
const bound = bindCode(emitted.code, emitted.params, {
	peer: TOKENS_FOR_SEED.content,
	cls: cursorClass,
	fadeMs: TIMINGS.virtualCursorFadeMs,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function boot(): { win: ReturnType<typeof makeWindow>; posts: Posted[]; keysBefore: string[] } {
	const win = makeWindow("https://www.chess.com/game/174252011111");
	cleanups.push(() => win.happyDOM.close());
	const rec = recordPosts(win);
	cleanups.push(rec.restore);
	const keysBefore = Object.keys(win);
	runProgram(bound, win);
	return { win, posts: rec.posts, keysBefore };
}

const el = (win: ReturnType<typeof makeWindow>) => win.document.querySelector(`.${cursorClass}`);

/** `cursorTo` envelope: the wire letters (`BRIDGE_WIRE`), no id — it is fire-and-forget. */
const to = (x: number, y: number, down = false): Record<string, unknown> => {
	const env = command("cursorTo", "0", { x, y, d: down });
	delete env.i;
	return env;
};

describe("virtual-cursor (the page-realm pointer mirror)", () => {
	it("emits no forbidden substring, no literal class and installs no window property", () => {
		expect(forbiddenIn(emitted.code)).toEqual([]);
		expect(emitted.code).not.toContain(cursorClass);
		expect(emitted.code).not.toMatch(/window\.\w+\s*=/);
		// the graphic travels inside the program: no asset URL (the manifest has no
		// `web_accessible_resources`) and no extension origin
		expect(emitted.code).not.toContain("chrome-extension");
		expect(emitted.code).toContain("<svg");
	});

	/**
	 * The fade is the one behaviour no simulator can check: happy-dom has no style recalculation,
	 * so deleting the forced flush between the `opacity:0` insert and the raise to 1 passes every
	 * behavioural test while the arrow pops instead of fading. This is the proxy that stops a
	 * refactor silently removing it; `docs/qa-checklist.md` §B5.5 is the browser check.
	 */
	it("inserts at opacity 0 and flushes style immediately after the insert (the fade's start value)", () => {
		expect(emitted.code).toContain(`ms ease;opacity:0`);
		expect(emitted.code).toMatch(/appendChild\(el\);\s*el\.getBoundingClientRect\(\)/);
		expect(emitted.code).toContain(`el.style.opacity = "1"`);
	});

	it("inserts nothing until the first position arrives", () => {
		const { win, keysBefore } = boot();
		expect(Object.keys(win)).toEqual(keysBefore);
		expect(win.document.body.children).toHaveLength(0);
		expect(el(win)).toBeNull();
	});

	it("draws one element on the first position, with no interactive surface and no stable id", () => {
		const { win, posts } = boot();
		sendToPage(win, to(100, 200));
		const node = el(win);
		expect(node).not.toBeNull();
		expect(win.document.querySelectorAll(`.${cursorClass}`)).toHaveLength(1);
		const style = (node as HTMLElement | null)?.style;
		expect(style?.pointerEvents).toBe("none");
		expect(style?.position).toBe("fixed");
		// §13.3 rule 3 over the WHOLE subtree, not just the wrapper: the inlined SVG is markup we
		// pasted, and re-pasting it from upstream would reintroduce the theme's `id="…-shadow"`.
		expect(node?.getAttribute("id")).toBeNull();
		expect(node?.outerHTML).not.toContain("id=");
		expect(node?.outerHTML).not.toContain("data-");
		expect(node?.querySelectorAll("path").length).toBeGreaterThan(0);
		// fire-and-forget: the page answers nothing at all
		expect(posts).toHaveLength(0);
	});

	it("is idempotent: a second position (and a second evaluation) keeps exactly one element", () => {
		const { win } = boot();
		sendToPage(win, to(100, 200));
		runProgram(bound, win); // a second evaluation finds the element in the DOM, not on `window`
		sendToPage(win, to(140, 260));
		expect(win.document.querySelectorAll(`.${cursorClass}`)).toHaveLength(1);
		expect(win.document.querySelectorAll("svg")).toHaveLength(1);
		// both listeners moved the same element to the latest point
		expect((el(win) as HTMLElement | null)?.style.transform).toBe(
			`translate3d(${140 - CURSOR_ART.hotX}px,${260 - CURSOR_ART.hotY}px,0)`
		);
	});

	it("positions the arrow tip on the point and dips on press", () => {
		const { win } = boot();
		sendToPage(win, to(100, 200));
		const style = (el(win) as HTMLElement | null)?.style;
		expect(style?.transform).toBe(
			`translate3d(${100 - CURSOR_ART.hotX}px,${200 - CURSOR_ART.hotY}px,0)`
		);
		expect(style?.opacity).toBe("1");

		sendToPage(win, to(100, 200, true));
		expect(style?.transform).toBe(
			`translate3d(${100 - CURSOR_ART.hotX}px,${200 - CURSOR_ART.hotY}px,0) scale(${CURSOR_ART.pressScale})`
		);
		sendToPage(win, to(100, 200, false));
		expect(style?.transform).not.toContain("scale(");
	});

	it("removes the element on hide, and a later position draws it again", () => {
		const { win } = boot();
		sendToPage(win, to(10, 10));
		expect(el(win)).not.toBeNull();
		const hide = command("cursorHide", "0");
		delete hide.i;
		sendToPage(win, hide);
		expect(el(win)).toBeNull();
		expect(win.document.querySelectorAll("svg")).toHaveLength(0);
		sendToPage(win, to(20, 20));
		expect(win.document.querySelectorAll(`.${cursorClass}`)).toHaveLength(1);
	});

	it("hides the native cursor only while the mirror exists and removes the override on hide", () => {
		const { win } = boot();
		expect(win.document.querySelector("style")).toBeNull();
		sendToPage(win, to(10, 10));
		const sheet = el(win)?.querySelector("style");
		expect(sheet?.textContent).toContain("cursor: none !important");
		const hide = command("cursorHide", "0");
		delete hide.i;
		sendToPage(win, hide);
		expect(win.document.querySelector("style")).toBeNull();
	});

	it("ignores a hide that arrives before anything was drawn", () => {
		const { win } = boot();
		const hide = command("cursorHide", "0");
		delete hide.i;
		expect(() => sendToPage(win, hide)).not.toThrow();
		expect(el(win)).toBeNull();
	});
});
