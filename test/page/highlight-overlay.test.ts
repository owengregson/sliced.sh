// test/page/highlight-overlay.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
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

function captureAnimations(win: ReturnType<typeof makeWindow>, reduced = false) {
	const records: Array<{
		node: unknown;
		frames: Keyframe[];
		options: KeyframeAnimationOptions;
		cancelled: boolean;
		finish(): void;
	}> = [];
	const prototype = win.Element.prototype;
	const previous = Object.getOwnPropertyDescriptor(prototype, "animate");
	Object.defineProperty(prototype, "animate", {
		configurable: true,
		value: function (this: unknown, frames: Keyframe[], options: KeyframeAnimationOptions) {
			let finish = () => {};
			let reject = (_error: Error) => {};
			const finished = new Promise<void>((resolve, fail) => {
				finish = resolve;
				reject = fail;
			});
			void finished.catch(() => {});
			const record = { node: this, frames, options, cancelled: false, finish };
			records.push(record);
			return {
				finished,
				cancel: () => {
					record.cancelled = true;
					reject(new Error("cancelled"));
				},
			};
		},
	});
	Object.defineProperty(win, "matchMedia", {
		configurable: true,
		value: () => ({ matches: reduced }),
	});
	cleanups.push(() => {
		if (previous) Object.defineProperty(prototype, "animate", previous);
		else Reflect.deleteProperty(prototype, "animate");
	});
	return records;
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
		expect(svgs[0]?.querySelector("linearGradient stop")?.getAttribute("stop-color")).toBe(
			OVERLAY_COLORS.arrow
		);
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
	it("uses one rounded silhouette with a fading source and a soft shadow instead of an outline", () => {
		const { win } = boot("<cg-container></cg-container>");
		sendToPage(win, command("draw", "1", { r: "w", h: [], a: [{ f: "a1", t: "a8" }] }));
		const arrow = win.document.querySelector("path");
		expect(win.document.querySelectorAll("path")).toHaveLength(1);
		expect(win.document.querySelectorAll("line, polygon")).toHaveLength(0);
		const shape = arrow?.getAttribute("d") ?? "";
		expect(shape).toContain(" Q ");
		expect(shape).not.toMatch(/NaN|Infinity/);
		// Local x points along the move; 6.75 board units reaches the centre of a8.
		expect(arrow?.parentElement?.getAttribute("transform")).toBe("translate(0.5 7.25) rotate(-90)");
		expect(shape).toContain("6.805,0");
		expect(arrow?.getAttribute("stroke")).toBeNull();
		const shadow = win.document.querySelector("feDropShadow");
		expect(shadow?.getAttribute("flood-color")).toBe(OVERLAY_COLORS.edge);
		expect(Number(shadow?.getAttribute("flood-opacity"))).toBeLessThan(0.2);
		expect(Number(shadow?.getAttribute("stdDeviation"))).toBeGreaterThan(0);
		// a1 → a8 is locally rotated -90 degrees; shadow remains screen-down.
		expect(Number(shadow?.getAttribute("dx"))).toBeLessThan(0);
		expect(Number(shadow?.getAttribute("dy"))).toBe(0);
		expect(arrow?.parentElement?.getAttribute("filter")).toBe(`url(#${shadow?.parentElement?.id})`);
		const gradients = [...win.document.querySelectorAll("linearGradient")];
		expect(gradients).toHaveLength(1);
		for (const paint of gradients) {
			expect(paint.id.startsWith(overlayClass)).toBe(true);
			expect(paint.firstElementChild?.getAttribute("stop-opacity")).toBe("0");
			expect(paint.lastElementChild?.getAttribute("stop-opacity")).toBe("1");
		}
		expect(gradients[0]?.firstElementChild?.getAttribute("stop-color")).toBe(OVERLAY_COLORS.arrow);
		const firstId = gradients[0]?.id;
		sendToPage(win, command("draw", "2", { r: "b", h: [], a: [{ f: "a1", t: "a8" }] }));
		expect(win.document.querySelector("linearGradient")?.id).not.toBe(firstId);
		expect(win.document.querySelector("path")?.parentElement?.getAttribute("transform")).toBe(
			"translate(7.5 0.75) rotate(90)"
		);
	});

	it("grows the complete arrow silhouette once, then fades the squares and arrow together", async () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		const payload = { r: "w", h: [{ q: "a1" }, { q: "a8" }], a: [{ f: "a1", t: "a8" }] };
		sendToPage(win, command("draw", "animated", payload));
		const arrow = win.document.querySelector("path");
		const growth = animations.find((a) => a.node === arrow);
		const fade = animations.find((a) => a.node === win.document.querySelector("svg > g"));
		const squareNodes = new Set<unknown>(win.document.querySelectorAll("rect"));
		const squares = animations.filter((a) => squareNodes.has(a.node));
		const fadeStart = HIGHLIGHT_MOTION.arrowDrawMs + HIGHLIGHT_MOTION.arrowHoldMs;
		const duration = fadeStart + HIGHLIGHT_MOTION.arrowFadeMs;
		expect(growth?.frames).toHaveLength(2);
		const frames = growth?.frames as Array<Keyframe & { d: string }>;
		expect(frames[0]?.d).not.toBe(frames[1]?.d);
		expect(frames[1]?.d).toBe(`path("${arrow?.getAttribute("d")}")`);
		expect(growth?.options.duration).toBe(HIGHLIGHT_MOTION.arrowDrawMs);
		expect(squares).toHaveLength(2);
		for (const square of squares) {
			expect(square.options).toEqual({ duration, fill: "forwards" });
			expect(square.frames).toEqual([
				{ opacity: 0, offset: 0, easing: "ease-out" },
				{ opacity: 1, offset: HIGHLIGHT_MOTION.squareInMs / duration },
				{ opacity: 1, offset: fadeStart / duration },
				{ opacity: 0, offset: 1 },
			]);
			expect(square.frames.slice(-2)).toEqual(fade?.frames.slice(-2) ?? []);
			expect(square.options.duration).toBe(fade?.options.duration);
		}
		expect(fade?.frames.at(-1)).toEqual({ opacity: 0, offset: 1 });
		expect(animations.every((a) => a.options.iterations === undefined)).toBe(true);
		sendToPage(win, command("draw", "same", payload));
		expect(animations).toHaveLength(4);
		for (const animation of animations) animation.finish();
		await Promise.resolve();
		expect(win.document.querySelector("path")).toBeNull();
		expect(win.document.querySelectorAll("rect")).toHaveLength(0);
		sendToPage(win, command("draw", "after-fade", payload));
		expect(animations).toHaveLength(4);
		expect(win.document.querySelectorAll("svg > *")).toHaveLength(0);
	});

	it("fades square-only highlights once without needing an arrow or replaying on duplicate updates", async () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		const payload = { r: "w", h: [{ q: "d2" }, { q: "d4" }], a: [] };
		sendToPage(win, command("draw", "squares", payload));
		expect(animations).toHaveLength(2);
		expect(win.document.querySelector("g")).toBeNull();
		for (const animation of animations) {
			expect(animation.options.duration).toBe(
				HIGHLIGHT_MOTION.arrowDrawMs + HIGHLIGHT_MOTION.arrowHoldMs + HIGHLIGHT_MOTION.arrowFadeMs
			);
			animation.finish();
		}
		await Promise.resolve();
		expect(win.document.querySelectorAll("rect")).toHaveLength(0);
		sendToPage(win, command("draw", "same-squares", payload));
		expect(animations).toHaveLength(2);
		expect(win.document.querySelectorAll("rect")).toHaveLength(0);
	});

	it("cancels old animations on replacement and clear, without stale completion removing the new mark", async () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(
			win,
			command("draw", "first", { r: "w", h: [{ q: "a1" }], a: [{ f: "a1", t: "a8" }] })
		);
		const first = [...animations];
		sendToPage(
			win,
			command("draw", "second", { r: "b", h: [{ q: "h1" }], a: [{ f: "h1", t: "h8" }] })
		);
		expect(first.every((a) => a.cancelled)).toBe(true);
		for (const a of first) a.finish();
		await Promise.resolve();
		expect(win.document.querySelectorAll("path")).toHaveLength(1);
		expect(win.document.querySelectorAll("rect")).toHaveLength(1);
		sendToPage(win, command("clear", "done"));
		expect(animations.every((a) => a.cancelled)).toBe(true);
		expect(win.document.querySelector("svg")).toBeNull();
	});

	it.each([false, true])(
		"cannot remove new marks when an old fade completes just before replacement, cleared=%s",
		async (cleared) => {
			const { win } = boot("<cg-container></cg-container>");
			const animations = captureAnimations(win);
			sendToPage(
				win,
				command("draw", "first", { r: "w", h: [{ q: "a1" }], a: [{ f: "a1", t: "a8" }] })
			);
			for (const animation of animations) animation.finish();
			if (cleared) sendToPage(win, command("clear", "clear"));
			sendToPage(
				win,
				command("draw", "replacement", { r: "w", h: [{ q: "d2" }], a: [{ f: "d2", t: "d4" }] })
			);
			await Promise.resolve();
			expect(win.document.querySelectorAll("rect")).toHaveLength(1);
			expect(win.document.querySelector("rect")?.getAttribute("x")).toBe("3");
			expect(win.document.querySelectorAll("path")).toHaveLength(1);
		}
	);

	it.each([false, true])(
		"keeps static usable marks without animation when reduced motion is enabled, squaresOnly=%s",
		(squaresOnly) => {
			const { win } = boot("<cg-container></cg-container>");
			const animations = captureAnimations(win, true);
			sendToPage(
				win,
				command("draw", "reduced", {
					r: "w",
					h: [{ q: "a1" }],
					a: squaresOnly ? [] : [{ f: "a1", t: "a8" }],
				})
			);
			expect(animations).toEqual([]);
			expect(win.document.querySelectorAll("rect")).toHaveLength(1);
			expect(win.document.querySelectorAll("path")).toHaveLength(squaresOnly ? 0 : 1);
		}
	);

	it.each([false, true])(
		"repairs an identical mark after the board host is replaced, faded=%s",
		async (faded) => {
			const { win } = boot("<cg-container></cg-container>");
			const animations = captureAnimations(win);
			const payload = { r: "w", h: [{ q: "a1" }], a: [{ f: "a1", t: "a8" }] };
			sendToPage(win, command("draw", "before-spa", payload));
			const first = [...animations];
			if (faded) {
				for (const animation of first) animation.finish();
				await Promise.resolve();
				expect(win.document.querySelectorAll("svg > *")).toHaveLength(0);
			}
			win.document.body.innerHTML = "<cg-container></cg-container>";
			sendToPage(win, command("draw", "after-spa", payload));
			expect(first.every((a) => a.cancelled)).toBe(true);
			expect(animations).toHaveLength(first.length * 2);
			expect(win.document.querySelectorAll("path")).toHaveLength(1);
			expect(win.document.querySelectorAll("rect")).toHaveLength(1);
		}
	);
});
