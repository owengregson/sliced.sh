// test/content/adapters/helpers.ts
/**
 * Shared helpers for the adapter tests: fixture loading into a tab DOM
 * (with the fixture's canonical URL), a fake `PageBridge`, and real-time
 * waiting utilities (happy-dom delivers MutationObserver records on the
 * window's real timers, so these tests run on real time with the 40 ms
 * adapter debounce).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PageBridge } from "@content/adapters/adapter";
import { createTabDom, type LayoutRect, type TabDom } from "@test/sim/dom/tab-dom";

export const FIXTURE_URLS = {
	"chesscom-live": "https://www.chess.com/game/live/173765478164",
	"chesscom-computer": "https://www.chess.com/play/computer",
	"chesscom-gameover": "https://www.chess.com/game/live/173765478165",
	"lichess-round-white": "https://lichess.org/abcdefgh1234",
	"lichess-round-black": "https://lichess.org/ijklmnop5678",
	"lichess-promotion": "https://lichess.org/qrstuvwx9012",
	"lichess-tv": "https://lichess.org/tv",
} as const;

export type FixtureName = keyof typeof FIXTURE_URLS;

const FIXTURE_DIR = path.resolve(import.meta.dir, "../../fixtures");

export function fixtureHtml(name: FixtureName): string {
	return readFileSync(path.join(FIXTURE_DIR, `${name}.html`), "utf8");
}

/** Body class + inner markup of a full-document fixture. */
function splitDocument(html: string): { head: string; bodyAttrs: string; body: string } {
	const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
	const bodyMatch = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
	return { head, bodyAttrs: bodyMatch?.[1] ?? "", body: bodyMatch?.[2] ?? html };
}

export function loadFixture(name: FixtureName, url: string = FIXTURE_URLS[name]): TabDom {
	const dom = createTabDom(url);
	const { head, bodyAttrs, body } = splitDocument(fixtureHtml(name));
	dom.document.documentElement.innerHTML = `<head>${head}</head><body${bodyAttrs}>${body}</body>`;
	installPollingObserver(dom);
	return dom;
}

/** Real-timer poll interval of the observer shim (well under the adapter debounce). */
const POLL_MS = 4;

/**
 * happy-dom 16.8 delivers MutationObserver records only for mutations made
 * before the first macrotask hop after load; everything later is dropped.
 * The adapters take `MutationObserver` from their `window`, so tests swap in
 * this polling shim: it snapshots the observed subtree every few ms and
 * reports one `childList` record (with the real added/removed elements) or
 * one `attributes` record when only markup changed. Chrome needs none of this.
 */
export function installPollingObserver(dom: TabDom): void {
	type Cb = (records: MutationRecord[], observer: MutationObserver) => void;
	class PollingObserver {
		private timer: ReturnType<typeof setInterval> | null = null;
		private target: Element | Document | null = null;
		private html = "";
		private nodes = new Set<Element>();
		constructor(private readonly cb: Cb) {}
		private snapshot(): { html: string; nodes: Set<Element> } {
			const t = this.target;
			if (!t) return { html: "", nodes: new Set() };
			const root = (t as Document).documentElement ?? (t as Element);
			return {
				html: root.outerHTML,
				nodes: new Set(Array.from(root.querySelectorAll("*")) as unknown as Element[]),
			};
		}
		observe(target: Element | Document): void {
			this.disconnect();
			this.target = target;
			const s = this.snapshot();
			this.html = s.html;
			this.nodes = s.nodes;
			this.timer = setInterval(() => this.poll(), POLL_MS);
		}
		private poll(): void {
			const s = this.snapshot();
			if (s.html === this.html) return;
			const added = [...s.nodes].filter((n) => !this.nodes.has(n));
			const removed = [...this.nodes].filter((n) => !s.nodes.has(n));
			this.html = s.html;
			this.nodes = s.nodes;
			const record = {
				type: added.length || removed.length ? "childList" : "attributes",
				target: this.target,
				addedNodes: added,
				removedNodes: removed,
			} as unknown as MutationRecord;
			this.cb([record], this as unknown as MutationObserver);
		}
		disconnect(): void {
			if (this.timer !== null) clearInterval(this.timer);
			this.timer = null;
		}
		takeRecords(): MutationRecord[] {
			return [];
		}
	}
	(dom.window as unknown as { MutationObserver: unknown }).MutationObserver = PollingObserver;
}

/** The `cg-board` piece rendered at chessground translate (x, y) px. */
export function lichessPiece(dom: TabDom, x: number, y: number): Element {
	const want = `translate(${x}px, ${y}px)`;
	for (const p of pageDocument(dom).querySelectorAll("cg-board piece")) {
		if ((p.getAttribute("style") ?? "").replace(/\s+/g, " ").includes(want)) return p;
	}
	throw new Error(`no piece at ${want}`);
}

/** The tab's happy-dom `Document` / `Window` typed as the DOM lib types the adapters take. */
export function pageDocument(dom: TabDom): Document {
	return dom.document as unknown as Document;
}

export function pageWindow(dom: TabDom): Window {
	return dom.window as unknown as Window;
}

/** `querySelector` on the tab document, typed as a DOM-lib `Element`; throws when nothing matches. */
export function q(dom: TabDom, selector: string): Element {
	const el = pageDocument(dom).querySelector(selector);
	if (!el) throw new Error(`no element matches ${selector}`);
	return el;
}

/** Dispatch a plain event of `type` on the tab window or document. */
export function fire(dom: TabDom, target: "window" | "document", type: string): void {
	const event = new dom.window.Event(type) as unknown as Event;
	if (target === "window") pageWindow(dom).dispatchEvent(event);
	else pageDocument(dom).dispatchEvent(event);
}

/** Board rectangle used by geometry tests: 8 × 66 px squares at (100, 100). */
export const BOARD_RECT: LayoutRect = { x: 100, y: 100, width: 528, height: 528 };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > end) throw new Error("waitFor: timed out");
		await sleep(5);
	}
}

export interface BridgeCall {
	kind: string;
	payload: unknown;
}

/** In-memory `PageBridge`: records calls, answers from `responses`, and can emit page events. */
export class FakeBridge implements PageBridge {
	readonly calls: BridgeCall[] = [];
	readonly responses = new Map<string, (payload: unknown) => unknown>();
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	available = true;

	isAvailable(): boolean {
		return this.available;
	}

	call<T = unknown>(kind: string, payload?: unknown): Promise<T> {
		this.calls.push({ kind, payload });
		const handler = this.responses.get(kind);
		if (!handler) return Promise.reject(new Error(`fake bridge: no handler for ${kind}`));
		return Promise.resolve(handler(payload) as T);
	}

	on(kind: string, cb: (payload: unknown) => void): () => void {
		let set = this.listeners.get(kind);
		if (!set) {
			set = new Set();
			this.listeners.set(kind, set);
		}
		set.add(cb);
		return () => {
			set?.delete(cb);
		};
	}

	emit(kind: string, payload: unknown): void {
		for (const cb of this.listeners.get(kind) ?? []) cb(payload);
	}

	callsOf(kind: string): BridgeCall[] {
		return this.calls.filter((c) => c.kind === kind);
	}
}

export interface StorageSpy {
	hits(): number;
	restore(): void;
}

/**
 * Count every `localStorage` / `sessionStorage` access on the given objects
 * (property getters). Also covers `document.cookie` on a document.
 */
export function spyPageStorage(...targets: object[]): StorageSpy {
	let hits = 0;
	const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
	for (const target of targets) {
		const keys = "cookie" in target ? ["cookie"] : ["localStorage", "sessionStorage"];
		for (const key of keys) {
			saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
			Object.defineProperty(target, key, {
				configurable: true,
				get() {
					hits += 1;
					return {};
				},
			});
		}
	}
	return {
		hits: () => hits,
		restore() {
			for (const [target, key, desc] of saved) {
				if (desc) Object.defineProperty(target, key, desc);
				else delete (target as Record<string, unknown>)[key];
			}
		},
	};
}
