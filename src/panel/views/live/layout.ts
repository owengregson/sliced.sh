/**
 * Live view measurement (Appendix F §8.2, §4.5).
 *
 * Measurement: the VIEWPORT (`window.innerHeight` / `documentElement.clientWidth`), never the
 * content box — `.sl-app` is `min-height: 100vh` and grows with its content, so its own box
 * can never be smaller than the layout. A `ResizeObserver` on `.sl-app` (width changes) plus
 * the window `resize` event (height; also the path happy-dom takes, whose observer never fires)
 * trigger a re-measure. The top bar is a fixed `control.lg` (its CSS height), the banner slot
 * is measured. Width < `layout.panelStandard` (360) is the compact breakpoint and
 * ≥ `layout.panelComfortable` (420) the comfortable one (the CSS container queries mirror both).
 */

import { TOKENS } from "@design/tokens.generated";

export interface LayoutMetrics {
	/** Height left for the view: viewport − top bar − banner slot. */
	availablePx: number;
	/** < 360 px (§8.1 compact). */
	compact: boolean;
	/** ≥ 420 px (§8.1 comfortable: PV depth column shown). */
	comfortable: boolean;
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

/** Viewport size — never an element's content box (see the header comment). */
export function viewportSize(app: HTMLElement | null): { width: number; height: number } {
	const doc = app?.ownerDocument ?? (typeof document === "undefined" ? null : document);
	const win = doc?.defaultView ?? (typeof window === "undefined" ? null : window);
	const root = doc?.documentElement ?? null;
	return {
		// clientWidth excludes a vertical scrollbar, which is what the container queries see.
		width: root?.clientWidth || win?.innerWidth || 0,
		height: win?.innerHeight || root?.clientHeight || 0,
	};
}

/** Read the current metrics (exported for the view's first paint). */
export function measureLayout(app: HTMLElement | null): LayoutMetrics {
	const { width, height } = viewportSize(app);
	const topbar = app?.querySelector<HTMLElement>(".sl-topbar") ?? null;
	const topbarHeight = topbar && !topbar.hidden ? heightOf(topbar) || TOKENS.size.control.lg : 0; // `LIVE_BUDGET.topBar`
	const banner = app?.querySelector<HTMLElement>(".sl-app__banner") ?? null;
	return {
		availablePx: Math.max(0, height - topbarHeight - heightOf(banner)),
		compact: width > 0 && width < TOKENS.layout.panelStandard,
		comfortable: width >= TOKENS.layout.panelComfortable,
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
