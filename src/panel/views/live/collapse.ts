/**
 * Live view height strategy (Appendix F §8.2) and the §4.5 compact breakpoint.
 *
 * The §8.2 budget (360×720, standard breakpoint) is transcribed into `LIVE_BUDGET`; where a row
 * is a token-sized control the token is used so the budget cannot drift from the CSS. The
 * available height is `viewport − top bar − banner`; `collapseFor` walks the six collapse
 * steps in the binding order (session strip → PV rows 3→2→1 → WDL fold → strength chip → move
 * card compact → scroll with the card pinned) until the layout fits. Each step is a discrete
 * state (`data-collapse` on the view root; no fluid scaling) so the layout is stable while
 * the user drags the panel edge.
 *
 * Measurement: a `ResizeObserver` on `.sl-app` when the platform delivers one, plus the window
 * `resize` event (the fallback that also serves happy-dom, whose observer never fires); the
 * height read is `.sl-app`'s box (min-height 100vh) or `window.innerHeight`. The top bar is a
 * fixed `control.lg` (its CSS height), the banner slot is measured. Width < `layout.panelStandard`
 * (360) is the compact breakpoint (the CSS container query on `.sl-app` mirrors it).
 */

import { TOKENS } from "@design/tokens.generated";

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
	need -= b.evalRow + b.gap;
	if (fits()) return state;

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

export interface LayoutMetrics {
	/** Height left for the view: `.sl-app` height − top bar − banner slot. */
	availablePx: number;
	compact: boolean;
}

export interface LayoutObserverOptions {
	/** The shell root (`.sl-app`); its ancestors are searched from the view container. */
	app: HTMLElement | null;
	onChange: (metrics: LayoutMetrics) => void;
}

function heightOf(el: HTMLElement | null): number {
	if (!el || el.hidden) return 0;
	return el.offsetHeight || 0;
}

/** Read the current metrics (exported for the view's first paint). */
export function measureLayout(app: HTMLElement | null): LayoutMetrics {
	const win = typeof window === "undefined" ? null : window;
	const appHeight =
		(app?.clientHeight || 0) > 0 ? (app?.clientHeight ?? 0) : (win?.innerHeight ?? 0);
	const appWidth = (app?.clientWidth || 0) > 0 ? (app?.clientWidth ?? 0) : (win?.innerWidth ?? 0);
	const topbar = app?.querySelector<HTMLElement>(".sl-topbar") ?? null;
	const topbarHeight = topbar && !topbar.hidden ? LIVE_BUDGET.topBar : 0;
	const banner = app?.querySelector<HTMLElement>(".sl-app__banner") ?? null;
	return {
		availablePx: Math.max(0, appHeight - topbarHeight - heightOf(banner)),
		compact: appWidth > 0 && appWidth < TOKENS.layout.panelStandard,
	};
}

/**
 * Watch the shell for size changes; `onChange` fires on every measurement (the caller
 * de-duplicates). Returns the disconnect.
 */
export function observeLayout(options: LayoutObserverOptions): () => void {
	const { app, onChange } = options;
	const emit = (): void => onChange(measureLayout(app));
	const win = typeof window === "undefined" ? null : window;
	let observer: ResizeObserver | null = null;
	const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
	if (app && typeof RO === "function") {
		try {
			observer = new RO(() => emit());
			observer.observe(app);
		} catch {
			observer = null;
		}
	}
	win?.addEventListener("resize", emit);
	return () => {
		observer?.disconnect();
		observer = null;
		win?.removeEventListener("resize", emit);
	};
}
