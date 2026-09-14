/**
 * Advantage bar: the eval bar's anatomy (`eval-bar.html`, `role="meter"` 0–100) driven by the
 * practical advantage index rather than the WDL model, drawn thinner and in the accent under the
 * eval rail. From the **owner's** point of view, unlike the rail above it: the accent is your
 * share and fills from the left (the caller hands the index already flipped to your side).
 */

import { advantageShare } from "@core/engine/advantage";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import html from "../views/templates/components/eval-bar.html?raw";

export interface AdvantageBarState {
	/** The index in [−1, 1] from the owner's point of view; `null` = nothing known yet. */
	index: number | null;
	stale?: boolean;
}

export interface AdvantageBarHandle {
	readonly el: HTMLElement;
	update(state: AdvantageBarState): void;
	dispose(): void;
}

const PERCENT = 100;

/** "Advantage · 62% you, 38% opponent". */
export function advantageValueText(index: number): string {
	const you = Math.round(advantageShare(index) * PERCENT);
	return COPY.advantage.valueText(you, PERCENT - you);
}

export function createAdvantageBar(host: HTMLElement | null): AdvantageBarHandle {
	const el = instantiate(html);
	el.classList.add("sl-evalbar--advantage");
	el.setAttribute("aria-label", COPY.advantage.label);
	const white = part(el, ".sl-evalbar__white");
	part(el, ".sl-evalbar__mate").hidden = true;

	function paint(share: number): void {
		const pct = Math.round(share * PERCENT);
		white.style.width = `${pct}%`;
		el.setAttribute("aria-valuenow", String(pct));
	}

	function update(state: AdvantageBarState): void {
		if (state.index === null) {
			el.classList.add("sl-evalbar--neutral");
			el.classList.remove("sl-evalbar--live", "sl-evalbar--stale");
			el.removeAttribute("aria-valuetext");
			el.removeAttribute("title");
			paint(0.5);
			return;
		}
		const text = advantageValueText(state.index);
		el.classList.remove("sl-evalbar--neutral");
		el.classList.add("sl-evalbar--live");
		el.classList.toggle("sl-evalbar--stale", state.stale === true);
		el.setAttribute("aria-valuetext", text);
		el.setAttribute("title", text);
		paint(advantageShare(state.index));
	}

	host?.append(el);
	return {
		el,
		update,
		dispose() {
			el.remove();
		},
	};
}
