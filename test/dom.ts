// test/dom.ts
/**
 * Opt-in happy-dom globals for tests that evaluate page-realm code with
 * `new Function`. The global preload (`test/setup.ts`) deliberately does not
 * install a DOM, so tests call `installDom()` themselves and dispose it
 * afterwards. `@happy-dom/global-registrator` is not a dependency; this helper
 * does the equivalent for the handful of globals page programs reach for.
 */

import { Window } from "happy-dom";

const GLOBAL_KEYS = [
	"window",
	"document",
	"location",
	"Node",
	"Element",
	"HTMLElement",
	"Event",
	"CustomEvent",
	"MessageEvent",
	"DOMRect",
] as const;

export interface DomHandle {
	window: Window;
	dispose(): void;
}

export function installDom(url = "https://example.test/"): DomHandle {
	const win = new Window({ url });
	const g = globalThis as Record<string, unknown>;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	const source = win as unknown as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		saved.set(key, Object.getOwnPropertyDescriptor(g, key));
		const value = key === "window" ? win : source[key];
		Object.defineProperty(g, key, { value, configurable: true, writable: true });
	}
	return {
		window: win,
		dispose(): void {
			for (const key of GLOBAL_KEYS) {
				const d = saved.get(key);
				if (d) Object.defineProperty(g, key, d);
				else delete g[key];
			}
		},
	};
}
