/**
 * Local account decoration: the chosen free title shown beside the signed-in account's own name,
 * wherever the page shows it (`free-title/placements.ts`), as a badge built and kept in step by
 * `free-title/decoration.ts`. Identity comes only from the signed-in sidebar profile link.
 */
import { FREE_TITLES, type FreeTitle } from "@core/constants/free-title";
import { TIMINGS } from "@core/constants/timings";
import {
	createDecoration,
	type Decoration,
	decorationStale,
	removeDecoration,
	syncDecoration,
} from "./free-title/decoration";
import { placementsOf, signedInAccount } from "./free-title/placements";

export interface FreeTitleBadges {
	/** Decorate the signed-in account with `value`, or remove every decoration (`null`). */
	set(value: FreeTitle | null): void;
	dispose(): void;
}

export function createFreeTitle(doc: Document, win: Window): FreeTitleBadges {
	let title: FreeTitle | null = null;
	let disposed = false;
	let queued = false;
	let timer: number | null = null;
	const decorations = new Map<Element, Decoration>();
	const wrappers = new WeakSet<Element>();
	const observer = new (doc.defaultView?.MutationObserver ?? MutationObserver)(schedule);
	const observe = () => {
		if (!title || disposed) return;
		observer.observe(doc.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["href", "class", "data-user-activity-key", "data-test-element", "style"],
		});
	};
	function render(): void {
		if (disposed) return;
		observer.disconnect();
		try {
			const own = title ? signedInAccount(doc, win) : null;
			const desired = own ? placementsOf(doc, win, own, wrappers) : [];
			const keys = new Set(desired.map((p) => p.key));
			for (const [key, saved] of decorations) {
				if (!keys.has(key)) {
					removeDecoration(saved, wrappers);
					decorations.delete(key);
				}
			}
			if (!title) return;
			for (const placement of desired) {
				let saved = decorations.get(placement.key);
				if (saved && decorationStale(saved, placement)) {
					removeDecoration(saved, wrappers);
					decorations.delete(placement.key);
					saved = undefined;
				}
				if (!saved) {
					saved = createDecoration(doc, win, placement, wrappers);
					decorations.set(placement.key, saved);
				}
				syncDecoration(saved, placement, title);
			}
		} finally {
			observe();
		}
	}
	function schedule(): void {
		if (queued || disposed || !title) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			render();
		});
	}
	win.addEventListener("popstate", schedule);
	return {
		set(value: FreeTitle | null): void {
			if (disposed) return;
			title = value && Object.hasOwn(FREE_TITLES, value) ? value : null;
			if (timer !== null) win.clearInterval(timer);
			// pushState need not mutate the DOM; recheck the route even on an otherwise static profile.
			timer = title ? win.setInterval(schedule, TIMINGS.adapterSelfCheckIntervalMs) : null;
			render();
		},
		dispose(): void {
			title = null;
			render();
			disposed = true;
			observer.disconnect();
			if (timer !== null) win.clearInterval(timer);
			win.removeEventListener("popstate", schedule);
		},
	};
}
