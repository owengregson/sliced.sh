/**
 * The page window's own observer and frame constructors. Tests inject a window whose
 * `MutationObserver` is a fake, and a stripped test window may lack the others, so every lookup
 * goes through the injected window first.
 */

/** The page's `MutationObserver` (the injected window in tests, the global in a content script). */
export function mutationObserverOf(win: Window): typeof MutationObserver {
	const w = win as unknown as { MutationObserver?: typeof MutationObserver };
	return w.MutationObserver ?? MutationObserver;
}

/** The page's `ResizeObserver` (absent in an old browser or a stripped test window). */
export function resizeObserverOf(win: Window): typeof ResizeObserver | null {
	const w = win as unknown as { ResizeObserver?: typeof ResizeObserver };
	const ctor = w.ResizeObserver ?? (typeof ResizeObserver === "function" ? ResizeObserver : null);
	return typeof ctor === "function" ? ctor : null;
}

/** The page's `requestAnimationFrame` (absent in a stripped test window). */
export function animationFrameOf(win: Window): ((cb: () => void) => number) | null {
	const raf = win.requestAnimationFrame;
	return typeof raf === "function" ? (cb) => raf.call(win, cb) : null;
}
