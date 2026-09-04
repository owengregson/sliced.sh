// test/sim/dom/tab-dom.ts
/**
 * A happy-dom window standing in for one tab's page. happy-dom has no
 * layout engine, so `elementFromPoint` and `getBoundingClientRect` are
 * driven by rectangles the test records with `layout(selector, rect)`:
 * the most recently recorded rectangle containing a point wins (it is "on
 * top"), and elements without a recorded rectangle keep happy-dom's
 * all-zero `DOMRect`.
 */

import { installGlobals } from "@test/sim/contexts/bus";
import { type Document, type Element, Window } from "happy-dom";

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface TabDom {
	readonly window: Window;
	readonly document: Document;
	readonly url: string;
	/** Replace `document.body`'s content. */
	setHTML(html: string): void;
	/** `querySelector` that throws when nothing matches. */
	query(selector: string): Element;
	focus(selector: string): void;
	/** `value` for inputs/textareas, `textContent` otherwise. */
	text(selector: string): string;
	/** Record the viewport rectangle of every element matching `selector`. */
	layout(selector: string, rect: LayoutRect): void;
	layoutElement(element: Element, rect: LayoutRect): void;
	/** Topmost recorded element containing the point, or `null`. */
	elementAt(x: number, y: number): Element | null;
	rectOf(element: Element): LayoutRect | null;
	/** Drop every recorded rectangle. */
	clearLayout(): void;
	close(): Promise<void>;
}

const isInputLike = (el: Element): el is Element & { value: string } =>
	el.tagName === "INPUT" || el.tagName === "TEXTAREA";

export function createTabDom(
	url: string,
	size: { width: number; height: number } = { width: 1280, height: 800 }
): TabDom {
	const window = new Window({ url, width: size.width, height: size.height });
	const document = window.document;
	document.documentElement.innerHTML = "<head></head><body></body>";
	const rects = new Map<Element, LayoutRect>();

	const query = (selector: string): Element => {
		const el = document.querySelector(selector);
		if (!el) throw new Error(`tab-dom: no element matches ${selector}`);
		return el;
	};

	const contains = (r: LayoutRect, x: number, y: number): boolean =>
		x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

	function elementAt(x: number, y: number): Element | null {
		let hit: Element | null = null;
		for (const [el, r] of rects) {
			if (el.isConnected && contains(r, x, y)) hit = el; // later registrations are on top
		}
		return hit;
	}

	function layoutElement(element: Element, rect: LayoutRect): void {
		rects.delete(element); // re-registering moves it to the top
		rects.set(element, { ...rect });
		Object.defineProperty(element, "getBoundingClientRect", {
			configurable: true,
			value: () => new window.DOMRect(rect.x, rect.y, rect.width, rect.height),
		});
	}

	const docPatch = document as unknown as {
		elementFromPoint: (x: number, y: number) => Element | null;
		elementsFromPoint: (x: number, y: number) => Element[];
	};
	docPatch.elementFromPoint = (x, y) => elementAt(x, y);
	docPatch.elementsFromPoint = (x, y) =>
		[...rects.entries()]
			.filter(([el, r]) => el.isConnected && contains(r, x, y))
			.map(([el]) => el)
			.reverse();

	return {
		window,
		document,
		url,
		setHTML(html) {
			document.body.innerHTML = html;
		},
		query,
		focus(selector) {
			const el = query(selector) as Element & { focus?: () => void };
			el.focus?.();
		},
		text(selector) {
			const el = query(selector);
			return isInputLike(el) ? el.value : (el.textContent ?? "");
		},
		layout(selector, rect) {
			const matches = document.querySelectorAll(selector);
			if (matches.length === 0) throw new Error(`tab-dom: no element matches ${selector}`);
			for (const el of matches) layoutElement(el, rect);
		},
		layoutElement,
		elementAt,
		rectOf: (element) => {
			const r = rects.get(element);
			return r ? { ...r } : null;
		},
		clearLayout() {
			rects.clear();
		},
		close: () => window.happyDOM.close(),
	};
}

const WINDOW_GLOBALS = [
	"Element",
	"HTMLElement",
	"HTMLInputElement",
	"HTMLButtonElement",
	"HTMLTextAreaElement",
	"HTMLSelectElement",
	"HTMLTemplateElement",
	"Node",
	"Text",
	"DocumentFragment",
	"Event",
	"CustomEvent",
	"MouseEvent",
	"PointerEvent",
	"KeyboardEvent",
	"DOMException",
	"MutationObserver",
	"ResizeObserver",
	"IntersectionObserver",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"localStorage",
	"sessionStorage",
	"location",
] as const;

/**
 * Expose a happy-dom window as the page globals (`window`, `document`, the
 * DOM constructors above) for code that reads them bare, the way a page
 * script does. Returns the restore function (teardown order does not matter,
 * see `installGlobals`).
 */
export function installWindowGlobals(window: Window): () => void {
	const values: Record<string, unknown> = { window, document: window.document };
	const w = window as unknown as Record<string, unknown>;
	for (const name of WINDOW_GLOBALS) {
		const value = w[name];
		if (value === undefined) continue;
		values[name] = typeof value === "function" && !/^[A-Z]/.test(name) ? value.bind(window) : value;
	}
	return installGlobals(values);
}
