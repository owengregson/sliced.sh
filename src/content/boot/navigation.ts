import { debounced } from "@content/adapters/adapter";
import { TIMINGS } from "@core/constants/timings";

/**
 * Page-kind re-detection triggers: `popstate` at once, `pushState` / `replaceState` via a
 * `location.href` poll (at `TIMINGS.adapterSelfCheckIntervalMs`, agnostic of which one ran), both
 * debounced by `TIMINGS.adapterDebounceMs`. Returns the remover.
 */
export function watchNavigation(win: Window, onNavigate: () => void): () => void {
	const pending = debounced(onNavigate, TIMINGS.adapterDebounceMs);
	const onPop = (): void => pending.trigger();
	win.addEventListener("popstate", onPop);
	let lastHref = win.location.href;
	const hrefTimer = setInterval(() => {
		if (win.location.href === lastHref) return;
		lastHref = win.location.href;
		pending.trigger();
	}, TIMINGS.adapterSelfCheckIntervalMs);
	return () => {
		pending.cancel();
		clearInterval(hrefTimer);
		win.removeEventListener("popstate", onPop);
	};
}
