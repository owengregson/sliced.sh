// test/page/virtual-cursor.test.ts — Fix D: the MAIN-world pointer mirror.
//
// The §13.3 rule 3 presence rules are the whole point of these tests: nothing is inserted until a
// position arrives, the element is found by its per-build class (not a `window` property, not an
// `id`), a second position redraws the same element rather than appending another, and `cursorHide`
// removes it. The graphic itself is checked only for what §13.3 constrains — no forbidden word, no
// stable identifier, `pointer-events: none` — plus the two things that make it readable as a
// pointer: the hotspot offset and the press feedback.
import { afterEach, describe, expect, it } from "bun:test";
import { CURSOR_EFFECTS, CURSOR_LAYER } from "@core/constants/cursor";
import { TIMINGS } from "@core/constants/timings";
import { TOKENS } from "@design/tokens.generated";
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
	accent: TOKENS.color.dark.brand,
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
/** `<html>`, untyped: happy-dom's class and lib.dom's `ParentNode` are not assignable either way. */
const html = (win: ReturnType<typeof makeWindow>): unknown => win.document.documentElement;

/** `cursorTo` envelope: the wire letters (`BRIDGE_WIRE`), no id — it is fire-and-forget. */
const to = (x: number, y: number, down = false): Record<string, unknown> => {
	const env = command("cursorTo", "0", { x, y, d: down });
	delete env.i;
	return env;
};

function animateHarness(win: ReturnType<typeof makeWindow>) {
	const records: Array<{
		node: unknown;
		frames: Keyframe[];
		options: KeyframeAnimationOptions;
		cancelled: boolean;
		done: boolean;
		cancel(): void;
		finish(): void;
	}> = [];
	const prototype = win.Element.prototype;
	const previousAnimate = Object.getOwnPropertyDescriptor(prototype, "animate");
	const previousGet = Object.getOwnPropertyDescriptor(prototype, "getAnimations");
	const preference = { reduced: false };
	Object.defineProperty(win, "matchMedia", {
		configurable: true,
		value: () => ({ matches: preference.reduced }),
	});
	Object.defineProperty(prototype, "animate", {
		configurable: true,
		value: function (this: unknown, frames: Keyframe[], options: KeyframeAnimationOptions) {
			let resolve = () => {};
			let reject = (_error: Error) => {};
			const finished = new Promise<void>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			void finished.catch(() => {});
			const record = {
				node: this,
				frames,
				options,
				cancelled: false,
				done: false,
				cancel() {
					this.cancelled = true;
					reject(new Error("cancelled"));
				},
				finish() {
					this.done = true;
					resolve();
				},
			};
			records.push(record);
			return { finished, cancel: () => record.cancel() };
		},
	});
	Object.defineProperty(prototype, "getAnimations", {
		configurable: true,
		value: function (this: unknown) {
			return records.filter((r) => r.node === this && !r.cancelled && !r.done);
		},
	});
	cleanups.push(() => {
		if (previousAnimate) Object.defineProperty(prototype, "animate", previousAnimate);
		else Reflect.deleteProperty(prototype, "animate");
		if (previousGet) Object.defineProperty(prototype, "getAnimations", previousGet);
		else Reflect.deleteProperty(prototype, "getAnimations");
	});
	return { records, preference, layer: () => win.document.querySelector(`.${cursorClass}e`) };
}

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

	/**
	 * 2026-09-13, "some popups go over it": a `z-index` competes only inside its stacking context,
	 * so the arrow is a direct child of `<html>` — where no site `transform` / `filter` / `contain`
	 * can open one above it — at the largest value CSS has. Everything that goes with it (the trail
	 * layer and the shield's no-popover fallback) sits one step under it, under the same host. What
	 * this cannot beat is the top layer, which is not a number; that limitation is recorded in
	 * `docs/qa/virtual-cursor-2026-09-13.md`.
	 */
	it("sits directly under <html> at the maximum z-index, with its layers one step below", () => {
		const { win } = boot();
		const h = animateHarness(win);
		sendToPage(win, to(100, 200));
		const node = el(win) as HTMLElement | null;
		expect(CURSOR_ART.zIndex).toBe(2_147_483_647);
		expect(CURSOR_LAYER.zIndex).toBe(2_147_483_647);
		expect(node?.style.zIndex).toBe(String(CURSOR_LAYER.zIndex));
		expect(Object.is(node?.parentNode, html(win))).toBe(true);
		// the arrow never lives in <body>, whose stacking context a site can change under it
		expect(win.document.body.children).toHaveLength(0);
		// the shield, where the popover API is missing, and the trail: both under <html>, both below
		sendToPage(win, command("cursorPrepare", "prepare", { x: 104, y: 200 }));
		const shield = win.document.querySelector(`.${cursorClass}h`) as HTMLElement | null;
		expect(Object.is(shield?.parentNode, html(win))).toBe(true);
		expect(shield?.style.zIndex).toBe(String(CURSOR_LAYER.underlayZIndex));
		sendToPage(win, to(104, 200));
		sendToPage(win, to(108, 200));
		const layer = h.layer() as HTMLElement | null;
		expect(Object.is(layer?.parentNode, html(win))).toBe(true);
		expect(layer?.style.zIndex).toBe(String(CURSOR_LAYER.underlayZIndex));
		expect(Number(layer?.style.zIndex)).toBeLessThan(Number(node?.style.zIndex));
		// and the emitted program carries no other z-index: nothing of ours is ever above the arrow
		const zs = [...emitted.code.matchAll(/z-index:(\d+)/g)].map((m) => Number(m[1]));
		expect(zs.length).toBeGreaterThan(0);
		expect(Math.max(...zs)).toBe(CURSOR_LAYER.zIndex);
		expect(zs.every((z) => z === CURSOR_LAYER.zIndex || z === CURSOR_LAYER.underlayZIndex)).toBe(
			true
		);
	});

	it("re-appends the arrow under <html> when the site moved it, instead of drawing a second one", () => {
		const { win } = boot();
		sendToPage(win, to(100, 200));
		const found = el(win);
		if (!found) throw new Error("no arrow");
		const node = found as unknown as HTMLElement;
		// a site re-render that swallows the element into its own container
		const container = win.document.createElement("div");
		win.document.body.appendChild(container);
		container.appendChild(found);
		expect(Object.is(node.parentNode, container)).toBe(true);
		sendToPage(win, to(120, 220));
		expect(win.document.querySelectorAll(`.${cursorClass}`)).toHaveLength(1);
		expect(Object.is(el(win), found)).toBe(true);
		expect(Object.is(node.parentNode, html(win))).toBe(true);
		expect(node.style.transform).toBe(
			`translate3d(${120 - CURSOR_ART.hotX}px,${220 - CURSOR_ART.hotY}px,0)`
		);
		// and one the site removed outright is drawn again, still under <html>
		node.remove();
		sendToPage(win, to(130, 230));
		expect(win.document.querySelectorAll(`.${cursorClass}`)).toHaveLength(1);
		expect(Object.is(el(win)?.parentNode, html(win))).toBe(true);
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
			`translate3d(${100 - CURSOR_ART.hotX}px,${200 - CURSOR_ART.hotY}px,0)`
		);
		expect((el(win)?.querySelector("svg") as unknown as SVGElement)?.style.transform).toBe(
			`scale(${CURSOR_ART.pressScale})`
		);
		sendToPage(win, to(100, 200, false));
		expect((el(win)?.querySelector("svg") as unknown as SVGElement)?.style.transform).toBe(
			"scale(1)"
		);
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

	it("shows the blocked native cursor while the mirror exists and removes the override on hide", () => {
		const { win } = boot();
		expect(win.document.querySelector("style")).toBeNull();
		sendToPage(win, to(10, 10));
		const sheet = el(win)?.querySelector("style");
		expect(sheet?.textContent).toContain("cursor: not-allowed !important");
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

	it("keeps one sealed native hit-test shield and removes it on hide, including repeated evaluation", () => {
		const { win } = boot();
		sendToPage(win, to(100, 200));
		const shield = () => win.document.querySelector(`.${cursorClass}h`) as HTMLElement | null;
		expect(shield()?.style.pointerEvents).toBe("auto");
		expect(shield()?.style.cursor).toBe("not-allowed");
		expect(shield()?.style.clipPath).toBe("none");
		runProgram(bound, win);
		sendToPage(win, to(200, 300));
		expect(win.document.querySelectorAll(`.${cursorClass}h`)).toHaveLength(1);
		sendToPage(win, command("cursorPrepare", "prepare", { x: 210, y: 310 }));
		expect(shield()?.style.clipPath).toContain("209px 309px");
		sendToPage(win, to(210, 310));
		expect(shield()?.style.clipPath).toBe("none");
		sendToPage(win, command("cursorHide", "hide"));
		expect(win.document.body.children).toHaveLength(0);
		expect(win.document.querySelectorAll(`[class^="${cursorClass}"]`)).toHaveLength(0);
		sendToPage(win, command("cursorPrepare", "late", { x: 210, y: 310 }));
		expect(win.document.body.children).toHaveLength(0);
		expect(win.document.querySelectorAll(`[class^="${cursorClass}"]`)).toHaveLength(0);
	});

	it("seals an aperture when dispatch never acknowledges it", async () => {
		const { win } = boot();
		sendToPage(win, to(100, 200));
		sendToPage(win, command("cursorPrepare", "prepare", { x: 150, y: 250 }));
		const shield = win.document.querySelector(`.${cursorClass}h`) as HTMLElement | null;
		expect(shield?.style.clipPath).toContain("149px 249px");
		await new Promise((resolve) => setTimeout(resolve, 280));
		expect(shield?.style.clipPath).toBe("none");
	});

	it("reuses a few translucent copies of the artwork trailing behind the cursor body", async () => {
		const { win } = boot();
		const h = animateHarness(win);
		sendToPage(win, to(100, 200));
		expect(h.layer()).toBeNull();
		// Two points: only the nearest ghost has a slot to sit in; the rest stay hidden.
		sendToPage(win, to(104, 200));
		sendToPage(win, to(108, 200));
		expect(h.layer()?.tagName.toLowerCase()).toBe("div");
		const early = [...(h.layer()?.children ?? [])] as unknown as HTMLElement[];
		expect(early).toHaveLength(CURSOR_EFFECTS.ghosts.length);
		expect(early[0]?.style.opacity).toBe(String(CURSOR_EFFECTS.ghosts[0]?.opacity));
		expect(early.slice(1).map((ghost) => ghost.style.opacity)).toEqual(["0", "0"]);
		for (let step = 3; step <= 25; step++) sendToPage(win, to(100 + step * 4, 200));
		const ghosts = [...(h.layer()?.children ?? [])] as unknown as HTMLElement[];
		expect(ghosts).toEqual(early);
		const art = el(win)?.querySelector("svg");
		let previousX = 200;
		ghosts.forEach((ghost, index) => {
			const spec = CURSOR_EFFECTS.ghosts[index];
			expect(ghost.tagName.toLowerCase()).toBe("svg");
			// The same artwork, never the press contour, tinted accent through and through.
			expect(ghost.childElementCount).toBe(2);
			expect(ghost.children[0]?.getAttribute("d")).toBe(art?.children[0]?.getAttribute("d"));
			expect(ghost.children[0]?.getAttribute("fill")).toBe(TOKENS.color.dark.brand);
			expect(ghost.children[1]?.getAttribute("fill")).toBe(TOKENS.color.dark.brand);
			expect(ghost.children[1]?.getAttribute("fill-opacity")).toBe(
				String(CURSOR_EFFECTS.ghostInnerOpacity)
			);
			expect(ghost.getAttribute("style")).toContain(
				`drop-shadow(0 0 ${CURSOR_EFFECTS.ghostShadowBlurPx}px ${TOKENS.color.dark.brand})`
			);
			expect(ghost.style.opacity).toBe(String(spec?.opacity));
			const x = Number(/translate3d\((-?[\d.]+)px/.exec(ghost.style.transform)?.[1]);
			// Each copy sits further back along the path than the one before it, behind the head.
			expect(x).toBe(200 - (spec?.lag ?? 0) * 4 - CURSOR_ART.hotX);
			expect(x).toBeLessThan(previousX);
			previousX = x;
		});
		expect(200 - (ghosts.length ? previousX + CURSOR_ART.hotX : 200)).toBeLessThanOrEqual(
			CURSOR_EFFECTS.trailLengthPx
		);
		const count = h.records.length;
		for (let i = 0; i < 10; i++) sendToPage(win, to(200, 200));
		expect(h.records).toHaveLength(count);
		for (const r of h.records) if (!r.cancelled) r.finish();
		await Promise.resolve();
		expect(h.layer()).toBeNull();
		expect(el(win)).not.toBeNull();
	});

	it("presses and releases the artwork itself with a matching contour, never a detached ring", () => {
		const { win } = boot();
		const h = animateHarness(win);
		sendToPage(win, to(100, 200));
		sendToPage(win, to(100, 200, true));
		sendToPage(win, to(100, 200, true));
		expect(h.records).toHaveLength(2);
		const art = el(win)?.querySelector("svg");
		const outline = art?.lastElementChild;
		expect(h.records[0]?.node).toBe(art);
		expect(h.records[1]?.node).toBe(outline);
		expect(outline?.getAttribute("d")).toBe(art?.children[1]?.getAttribute("d"));
		expect(outline?.getAttribute("stroke")).toBe(TOKENS.color.dark.brand);
		expect(h.layer()).toBeNull();
		expect(win.document.querySelector("circle")).toBeNull();
		expect((el(win) as HTMLElement | null)?.style.transform).toBe("translate3d(95px,195px,0)");
		sendToPage(win, to(100, 200, false));
		sendToPage(win, to(100, 200, false));
		expect(h.records).toHaveLength(4);
		expect(h.records[2]?.options.duration).toBe(CURSOR_EFFECTS.releaseMs);
		expect(h.records[2]?.frames.at(-1)).toEqual({ transform: "scale(1)" });
		expect(h.records[3]?.frames.at(-1)).toEqual({ opacity: 0 });
	});

	it("skips teleports, cancels effects on reduced motion and hide, and never trails across ownership sessions", async () => {
		const { win } = boot();
		const h = animateHarness(win);
		sendToPage(win, to(10, 10));
		sendToPage(win, to(20, 10));
		sendToPage(win, to(500, 500));
		expect(h.layer()).toBeNull();
		expect(h.records.every((r) => r.cancelled)).toBe(true);
		sendToPage(win, to(510, 500));
		h.preference.reduced = true;
		sendToPage(win, to(520, 500, true));
		expect(h.layer()).toBeNull();
		expect(h.records.every((r) => r.cancelled)).toBe(true);
		expect((el(win) as HTMLElement | null)?.style.transform).toContain("515px,495px");
		h.preference.reduced = false;
		sendToPage(win, to(530, 500, false));
		sendToPage(win, command("cursorHide", "hide"));
		expect(h.records.every((r) => r.cancelled)).toBe(true);
		expect(win.document.body.children).toHaveLength(0);
		expect(win.document.querySelectorAll(`[class^="${cursorClass}"]`)).toHaveLength(0);
		await Promise.resolve();
		sendToPage(win, to(600, 600));
		expect(h.layer()).toBeNull();
	});

	it("draws the plain arrow only when the owner turned the effects off", () => {
		const { win } = boot();
		const h = animateHarness(win);
		const off = (x: number, y: number, down = false): Record<string, unknown> => {
			const env = command("cursorTo", "0", { x, y, d: down, e: false });
			delete env.i;
			return env;
		};
		sendToPage(win, off(100, 200));
		for (let step = 1; step <= 8; step++) sendToPage(win, off(100 + step * 4, 200));
		sendToPage(win, off(140, 200, true));
		sendToPage(win, off(140, 200, false));
		expect(h.layer()).toBeNull();
		expect(h.records).toEqual([]);
		expect((el(win) as HTMLElement | null)?.style.transform).toContain("135px,195px");
		// Turning them back on resumes the trail from the next points.
		sendToPage(win, to(144, 200));
		sendToPage(win, to(148, 200));
		sendToPage(win, to(152, 200));
		expect(h.layer()).not.toBeNull();
	});

	it("shows the pointer immediately without effects when reduced motion is already enabled", () => {
		const { win } = boot();
		const h = animateHarness(win);
		h.preference.reduced = true;
		sendToPage(win, to(100, 200));
		sendToPage(win, to(110, 200, true));
		sendToPage(win, to(110, 200, false));
		expect(h.records).toEqual([]);
		expect(h.layer()).toBeNull();
		expect((el(win) as HTMLElement | null)?.style.transition).toBe("none");
	});
});
