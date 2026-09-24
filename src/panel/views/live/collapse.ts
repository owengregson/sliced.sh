/**
 * Live view height strategy (Appendix F §8.2) and the §4.5 compact breakpoint.
 *
 * The §8.2 budget (360×720, standard breakpoint) is transcribed into `LIVE_BUDGET`; where a row
 * is a token-sized control the token is used so the budget cannot drift from the CSS. The
 * available height is `viewport − top bar − banner`; `collapseFor` walks the collapse steps in
 * the binding order (session strip → PV rows 3→2→1 → WDL fold → strength chip → move card
 * compact) until the layout fits, and — §8.2 step 6, literally — below 480 px of available
 * height the state is always `scroll` (every step applied, the move card pinned to the viewport
 * under the top bar). Each step is a discrete state (`data-collapse` on the view root; no fluid
 * scaling) so the layout is stable while the user drags the panel edge.
 *
 * The evaluation chip remains visible at every height. Folding WDL no longer removes its row,
 * so that step cannot claim height savings; the next step folds the strength card instead.
 *
 * Measuring the viewport lives in `layout.ts` (re-exported here).
 */

import { LIVE_LAYOUT } from "@core/constants/ui";
import { TOKENS } from "@design/tokens.generated";

export {
	type LayoutMetrics,
	type LayoutObserverOptions,
	measureLayout,
	observeLayout,
	viewportSize,
} from "./layout";

/** Appendix F §8.2 budget at 360×720 (px). */
export const LIVE_BUDGET = {
	topBar: TOKENS.size.control.lg,
	playerRow: TOKENS.type.leading["2xl"],
	evalRow: TOKENS.type.leading["4xl"],
	/** Move card, your move, armed (header · hero · plan · button and paddings). */
	moveCard: 168,
	linesHeader: TOKENS.size.control.sm,
	pvRow: TOKENS.size.control.sm,
	strengthCard: TOKENS.size.control.lg,
	togglesRow: TOKENS.size.control.lg,
	sessionStrip: TOKENS.size.control.md,
	/** `space.4` between blocks; six gaps in the full layout. */
	gap: TOKENS.space[4],
	gaps: 6,
	/** Step 5: `move-sm`, `space.3` padding, plan line merged into the button (≈ 56). */
	moveCompactSaves: 56,
} as const;

export const COLLAPSE_STEPS = ["strip", "pv", "wdl", "strength", "move", "scroll"] as const;
/** §8.2 step 6 threshold on the available height. */
export const SCROLL_BELOW_PX = LIVE_LAYOUT.scrollBelowPx;
export type CollapseStep = (typeof COLLAPSE_STEPS)[number];
export type CollapseName = "full" | CollapseStep;

export interface CollapseState {
	/** 0 = nothing collapsed; 1–6 = the last step applied. */
	level: number;
	name: CollapseName;
	stripHidden: boolean;
	/** Rows to show (never 0 while a line exists). */
	pvMax: number;
	wdlFolded: boolean;
	strengthChip: boolean;
	moveCompact: boolean;
	scroll: boolean;
}

/** Full live layout height (below the top bar) for `pvCount` rows. */
export function liveLayoutHeight(pvCount: number): number {
	const b = LIVE_BUDGET;
	return (
		b.playerRow * 2 +
		b.evalRow +
		b.moveCard +
		b.linesHeader +
		b.pvRow * pvCount +
		b.strengthCard +
		b.togglesRow +
		b.sessionStrip +
		b.gap * b.gaps
	);
}

export function collapseFor(availablePx: number, pvCount: number): CollapseState {
	const b = LIVE_BUDGET;
	const state: CollapseState = {
		level: 0,
		name: "full",
		stripHidden: false,
		pvMax: Math.max(1, pvCount),
		wdlFolded: false,
		strengthChip: false,
		moveCompact: false,
		scroll: false,
	};
	let need = liveLayoutHeight(state.pvMax);
	// §8.2 step 6: below 480 px the view scrolls — every step applied, the card pinned.
	if (availablePx < SCROLL_BELOW_PX) {
		return {
			...state,
			level: 6,
			name: "scroll",
			stripHidden: true,
			pvMax: 1,
			wdlFolded: true,
			strengthChip: true,
			moveCompact: true,
			scroll: true,
		};
	}
	const fits = (): boolean => need <= availablePx;
	if (fits()) return state;

	state.level = 1;
	state.name = "strip";
	state.stripHidden = true;
	need -= b.sessionStrip + b.gap;
	if (fits()) return state;

	while (state.pvMax > 1) {
		state.level = 2;
		state.name = "pv";
		state.pvMax -= 1;
		need -= b.pvRow;
		if (fits()) return state;
	}

	state.level = 3;
	state.name = "wdl";
	state.wdlFolded = true;
	// The persistent evaluation chip still occupies this row after WDL is folded.

	state.level = 4;
	state.name = "strength";
	state.strengthChip = true;
	need -= b.strengthCard + b.gap;
	if (fits()) return state;

	state.level = 5;
	state.name = "move";
	state.moveCompact = true;
	need -= b.moveCompactSaves;
	if (fits()) return state;

	state.level = 6;
	state.name = "scroll";
	state.scroll = true;
	return state;
}
