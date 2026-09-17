import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { BRIDGE_KINDS } from "@content/adapters/adapter";
import { readMoveList } from "@content/adapters/move-list";
import {
	MOVE_QUALITY_ORDER,
	moveQualityIndex,
	MOVE_QUALITY as Q,
} from "@core/constants/move-quality";
import { bindCode, emit } from "@pagescript";
import { type Element as HappyElement, type Node as HappyNode, PropertySymbol } from "happy-dom";
import { chesscomBridge } from "../../src/page/chesscom-bridge";
import { chesscomEntryArgs } from "../../src/page/index";
import {
	command,
	fakeGame,
	makeWindow,
	postsOf,
	recordPosts,
	runProgram,
	SEED,
	sendToPage,
	sleep,
	waitFor,
} from "./helpers";

const args = chesscomEntryArgs({ seed: SEED });
const emitted = emit(chesscomBridge, { seed: SEED });
const code = bindCode(emitted.code, emitted.params, args);
const selector = `.${args.moveListClass}`;
const notation = (node: HappyElement) =>
	[...node.querySelectorAll("span")].filter((el) => el.matches(".node-highlight-content"));
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
});

async function boot(html = "") {
	const win = makeWindow("https://www.chess.com/game/live/123");
	cleanups.push(() => win.happyDOM.close());
	win.document.body.innerHTML = `<wc-chess-board></wc-chess-board><wc-simple-move-list>${html}</wc-simple-move-list>`;
	Object.assign(win.document.querySelector("wc-chess-board") ?? {}, { game: fakeGame() });
	const rec = recordPosts(win);
	// happy-dom 16 keeps its internal delivery closure only in a WeakRef. Hold it for
	// the test's lifetime so collection cannot silently disable a native observer.
	const retained = new Set<object>();
	class Observer extends win.MutationObserver {
		override observe(target: HappyNode, options: MutationObserverInit): void {
			super.observe(target, options);
			for (const listener of target[PropertySymbol.mutationListeners]) {
				const callback = listener.callback.deref();
				if (callback) retained.add(callback);
			}
		}
	}
	cleanups.push(() => retained.clear());
	runProgram(code, win, {
		MutationObserver: Observer,
		customElements: { whenDefined: () => Promise.resolve() },
	});
	await waitFor(() => postsOf(rec.posts, "ready").length > 0);
	const list = win.document.querySelector("wc-simple-move-list");
	if (!list) throw new Error("missing fixture");
	return {
		win,
		list,
		draw: (rows: unknown[]) => sendToPage(win, command(BRIDGE_KINDS.moveListRatings, "log", rows)),
	};
}

const row = (ply: number, san: string) =>
	`<div class="main-line-row" data-whole-move-number="${Math.floor(ply / 2) + 1}"><div class="node main-line-ply ${ply % 2 ? "black" : "white"}-move" data-node="0-${ply}"><span class="node-highlight-content selected">${san}</span></div><div data-ply="${ply + 1}" data-move-list-el="timestamp">3.6s</div></div>`;

it.each(["annotated", "blank"])(
	"annotates the supplied %s log without changing SAN, selection, timestamps or native icons",
	async (name) => {
		const html = readFileSync(new URL(`../fixtures/move-list/${name}.html`, import.meta.url), "utf8");
		const { win, list, draw } = await boot(html);
		const before = readMoveList(win.document as unknown as Document);
		const native = list.querySelectorAll(".node-annotation-icon").length;
		const original = notation(list).map((text) => ({
			color: text.style.getPropertyValue("color"),
			priority: text.style.getPropertyPriority("color"),
			offset: text.classList.contains("offset-for-annotation-icon"),
		}));
		const timestamps = [...list.querySelectorAll('[data-move-list-el="timestamp"]')].map(
			(node) => node.outerHTML
		);
		expect(before.sans.length).toBeGreaterThan(30);
		const rows = before.sans.map((san, ply) => [ply, san, ply % MOVE_QUALITY_ORDER.length]);
		draw(rows);
		expect(list.querySelectorAll(selector)).toHaveLength(before.sans.length);
		expect(readMoveList(win.document as unknown as Document)).toEqual(before);
		for (const badge of list.querySelectorAll(selector)) {
			const text = badge.parentElement ? notation(badge.parentElement)[0] : undefined;
			expect(badge.parentElement?.firstChild).toBe(badge);
			expect(badge.getAttribute("style")).toContain(
				"margin-bottom:2.5px;margin-left:2px;margin-right:0px"
			);
			const reference = win.document.createElement("span");
			reference.style.color = badge.querySelector("circle")?.getAttribute("fill") ?? "";
			expect(text?.style.color).toBe(reference.style.color);
			expect(text?.classList.contains("offset-for-annotation-icon")).toBe(false);
		}
		expect(list.querySelectorAll(".node-annotation-icon")).toHaveLength(native);
		expect(
			[...list.querySelectorAll('[data-move-list-el="timestamp"]')].map((node) => node.outerHTML)
		).toEqual(timestamps);
		draw(rows);
		expect(list.querySelectorAll(selector)).toHaveLength(before.sans.length);
		draw([]);
		expect(list.querySelectorAll(selector)).toHaveLength(0);
		expect(
			notation(list).map((text) => ({
				color: text.style.getPropertyValue("color"),
				priority: text.style.getPropertyPriority("color"),
				offset: text.classList.contains("offset-for-annotation-icon"),
			}))
		).toEqual(original);
		expect(readMoveList(win.document as unknown as Document)).toEqual(before);
	}
);

it("fills ratings arriving before the DOM, restores rerendered rows and corrects recycled nodes", async () => {
	const { list, draw } = await boot();
	draw([
		[0, "e4", moveQualityIndex("best")],
		[1, "c6", moveQualityIndex("book")],
	]);
	list.innerHTML = row(0, "e4") + row(1, "c6");
	await waitFor(() => list.querySelectorAll(selector).length === 2);
	expect(list.querySelector(selector)?.getAttribute("aria-label")).toBe("Bot: Best");
	list.innerHTML = row(0, "e4") + row(1, "c6");
	await waitFor(() => list.querySelectorAll(selector).length === 2);
	const san = notation(list)[0];
	if (san) san.textContent = "d4";
	await waitFor(() => list.querySelectorAll(selector).length === 1);
	const node = list.querySelector(".node");
	node?.setAttribute("data-node", "1-0");
	if (san) san.textContent = "e4";
	await sleep(20);
	expect(node?.querySelector(selector)).toBeNull();
	draw([]);
	list.innerHTML = row(0, "e4");
	await sleep(20);
	expect(list.querySelector(selector)).toBeNull();
});

it("handles figurines and castling and preserves clicks on live move nodes", async () => {
	const { win, list, draw } = await boot(
		row(2, '<span data-figurine="N"></span>f3') + row(3, "0-0")
	);
	const node = list.querySelector(".node");
	let clicks = 0;
	node?.addEventListener("click", () => clicks++);
	draw([
		[2, "Nf3", 6],
		[3, "O-O", 4],
	]);
	expect(list.querySelectorAll(selector)).toHaveLength(2);
	node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
	expect(clicks).toBe(1);
	expect(readMoveList(win.document as unknown as Document).sans).toEqual(["Nf3", "O-O"]);
});

it("recolors replacement notation and restores native color after a recycled row no longer matches", async () => {
	const { list, draw } = await boot(row(0, "e4"));
	const node = list.querySelector(".node");
	if (!node) throw new Error("missing node");
	const text = node.querySelector("span");
	if (!text) throw new Error("missing notation");
	text.style.setProperty("color", "red", "important");
	text.classList.add("offset-for-annotation-icon");
	draw([[0, "e4", moveQualityIndex("brilliant")]]);
	expect(text.style.color).not.toBe("red");
	text.textContent = "d4";
	await waitFor(() => !node.querySelector(selector));
	expect(text.style.getPropertyValue("color")).toBe("red");
	expect(text.style.getPropertyPriority("color")).toBe("important");
	expect(text.classList.contains("offset-for-annotation-icon")).toBe(true);
	text.textContent = "e4";
	await waitFor(() => !!node.querySelector(selector));
	const replacement = text.cloneNode(true);
	replacement.style.color = "blue";
	text.replaceWith(replacement);
	await waitFor(() => replacement.style.color !== "blue");
	draw([]);
	expect(replacement.style.color).toBe("blue");
});

it.each([false, true])(
	"animates arrivals once with the board entrance and a slower text fade (reduced motion: %s)",
	async (reduced) => {
		const { win, list, draw } = await boot(row(0, "e4"));
		const animations: Array<{
			node: HappyElement;
			frames: Keyframe[];
			options: KeyframeAnimationOptions;
			cancelled: boolean;
		}> = [];
		const proto = win.Element.prototype;
		const previous = Object.getOwnPropertyDescriptor(proto, "animate");
		Object.defineProperty(proto, "animate", {
			configurable: true,
			value: function (this: HappyElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
				const animation = { node: this, frames, options, cancelled: false };
				animations.push(animation);
				return {
					cancel() {
						animation.cancelled = true;
					},
				};
			},
		});
		cleanups.push(() => {
			if (previous) Object.defineProperty(proto, "animate", previous);
			else Reflect.deleteProperty(proto, "animate");
		});
		Object.defineProperty(win, "matchMedia", { value: () => ({ matches: reduced }) });
		const text = notation(list)[0];
		if (!text) throw new Error("missing notation");
		text.style.color = "rgb(200, 200, 200)";
		const rows = [[0, "e4", moveQualityIndex("brilliant")]];
		draw(rows);
		if (reduced) expect(animations).toHaveLength(0);
		else {
			expect(animations).toHaveLength(2);
			const icon = animations.find((a) => a.node.matches(selector));
			const color = animations.find((a) => a.node === text);
			expect(icon?.frames).toEqual([
				{ opacity: 0, transform: `scale(${Q.chipScaleFrom})`, offset: 0, easing: Q.chipEasing },
				{ opacity: Q.chipOpacity, transform: `scale(${Q.chipScalePeak})`, offset: Q.chipOvershootAt },
				{ opacity: Q.chipOpacity, transform: "scale(1)", offset: 1 },
			]);
			expect(icon?.options.duration).toBe(200);
			expect(color?.options.duration).toBe(320);
			expect(color?.frames[0]?.color).toBe("rgb(200, 200, 200)");
			expect(color?.frames[1]?.color).toBe(
				list.querySelector(`${selector} circle`)?.getAttribute("fill")
			);
		}
		draw(rows);
		list.innerHTML = row(0, "e4");
		await waitFor(() => list.querySelectorAll(selector).length === 1);
		expect(animations).toHaveLength(reduced ? 0 : 2);
		if (!reduced) expect(animations.find((a) => a.node === text)?.cancelled).toBe(true);
		draw([]);
		expect(list.querySelector(selector)).toBeNull();
	}
);
