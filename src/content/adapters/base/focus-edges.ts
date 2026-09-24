import type { FocusEdge } from "../contract";

/**
 * Passive capture listeners for `window` focus/blur and `document`
 * visibilitychange; every edge is reported (V2 §13.4). Returns the remover.
 *
 * The current state is reported **once at install**, before any edge. Without it the service
 * worker's `FocusGate` has no reading at all until the page first gains or loses focus, and
 * `canExecute` answers `unfocused` while it has none — so a tab that was already focused when the
 * content script loaded, armed with the `Shift+A` shortcut (which by design produces no focus edge),
 * would have every move skipped and nothing to release it. Playing white at ply 0 that is the
 * owner's "it sometimes doesnt make the first move" with no focus edge anywhere in sight. This is a
 * passive read of `document.hasFocus()` — the same one every edge makes — and moves focus nowhere.
 */
export function installFocusEdges(
	win: Window,
	doc: Document,
	cb: (edge: FocusEdge) => void
): () => void {
	const opts: AddEventListenerOptions = { capture: true, passive: true };
	const report = (): void => {
		cb({
			hasFocus: typeof doc.hasFocus === "function" ? doc.hasFocus() : true,
			visibility: doc.visibilityState === "hidden" ? "hidden" : "visible",
			at: Date.now(),
		});
	};
	win.addEventListener("focus", report, opts);
	win.addEventListener("blur", report, opts);
	doc.addEventListener("visibilitychange", report, opts);
	report();
	return () => {
		win.removeEventListener("focus", report, opts);
		win.removeEventListener("blur", report, opts);
		doc.removeEventListener("visibilitychange", report, opts);
	};
}
