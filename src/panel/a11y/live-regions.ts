/**
 * Live regions: a polite (`role="status"`) and an assertive (`role="alert"`) visually-hidden
 * region in the shell; `announce` writes into them, debounced per politeness
 * (`UI_TIMINGS.announceDebounceMs`) so bursts collapse to the last text, and re-announces
 * identical text by clearing first.
 */

import { UI_TIMINGS } from "@core/constants/ui";

export type Politeness = "polite" | "assertive";

const POLITENESS: readonly Politeness[] = ["polite", "assertive"];

interface LiveRegions {
	host: HTMLElement;
	regions: Record<Politeness, HTMLElement>;
	timers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>>;
	pending: Partial<Record<Politeness, string>>;
}

let live: LiveRegions | null = null;

function clearTimers(state: LiveRegions): void {
	for (const p of POLITENESS) {
		const t = state.timers[p];
		if (t !== undefined) clearTimeout(t);
		delete state.timers[p];
		delete state.pending[p];
	}
}

/** Create the two visually-hidden live regions inside `host`; returns the unmount. */
export function mountLiveRegions(host: HTMLElement): () => void {
	if (live) disposeLiveRegions();
	const doc = host.ownerDocument;
	const make = (politeness: Politeness): HTMLElement => {
		const el = doc.createElement("div");
		el.className = "sl-visually-hidden";
		el.setAttribute("aria-live", politeness);
		el.setAttribute("role", politeness === "assertive" ? "alert" : "status");
		el.setAttribute("aria-atomic", "true");
		host.append(el);
		return el;
	};
	const state: LiveRegions = {
		host,
		regions: { polite: make("polite"), assertive: make("assertive") },
		timers: {},
		pending: {},
	};
	live = state;
	return () => {
		if (live !== state) return;
		disposeLiveRegions();
	};
}

/** Remove the regions and drop pending announcements (shell dispose, tests). */
export function disposeLiveRegions(): void {
	if (!live) return;
	clearTimers(live);
	for (const p of POLITENESS) live.regions[p].remove();
	live = null;
}

function flush(state: LiveRegions, politeness: Politeness): void {
	delete state.timers[politeness];
	const text = state.pending[politeness] ?? "";
	delete state.pending[politeness];
	const region = state.regions[politeness];
	if (text !== "" && region.textContent === text) {
		// Same text twice: clear first so assistive tech treats the refill as a new message.
		region.textContent = "";
		state.timers[politeness] = setTimeout(() => {
			delete state.timers[politeness];
			if (live === state && state.pending[politeness] === undefined) region.textContent = text;
		}, 0);
		return;
	}
	region.textContent = text;
}

/**
 * Announce `text` through the live region of the given politeness. Calls within
 * `UI_TIMINGS.announceDebounceMs` collapse to the last text; "" clears the region. A no-op when
 * no regions are mounted.
 */
export function announce(text: string, politeness: Politeness = "polite"): void {
	const state = live;
	if (!state) return;
	state.pending[politeness] = text;
	const existing = state.timers[politeness];
	if (existing !== undefined) clearTimeout(existing);
	state.timers[politeness] = setTimeout(
		() => flush(state, politeness),
		UI_TIMINGS.announceDebounceMs
	);
}
