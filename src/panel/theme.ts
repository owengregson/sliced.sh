/**
 * Theme and motion preference resolution (Part I §10.2: `data-theme="system"` is resolved to
 * dark/light from `prefers-color-scheme`; Appendix F §8.4 reduced motion).
 *
 * `Settings.display.theme` → `data-theme` on the shell root; `Settings.display.reducedMotion`
 * (`system | on | off`) → `data-reduced-motion="true"` so CSS and JS (`isReducedMotion`) agree.
 */

import type { Settings } from "@typedefs/settings";

export type ResolvedTheme = "dark" | "light";

export const MEDIA_QUERIES = {
	light: "(prefers-color-scheme: light)",
	reducedMotion: "(prefers-reduced-motion: reduce)",
} as const;

export type MatchMedia = (query: string) => MediaQueryList | null;

export interface ThemeController {
	readonly theme: ResolvedTheme;
	readonly reducedMotion: boolean;
	apply(display: Pick<Settings["display"], "theme" | "reducedMotion">): void;
	onChange(cb: (state: { theme: ResolvedTheme; reducedMotion: boolean }) => void): () => void;
	dispose(): void;
}

function defaultMatchMedia(query: string): MediaQueryList | null {
	const w = globalThis as { matchMedia?: (q: string) => MediaQueryList };
	if (typeof w.matchMedia !== "function") return null;
	try {
		return w.matchMedia(query);
	} catch {
		return null;
	}
}

/** Whether reduced motion is in effect for the shell (settings override or OS preference). */
export function isReducedMotion(root?: HTMLElement | null): boolean {
	const el = root ?? (typeof document === "undefined" ? null : document.body);
	const flag = el?.dataset.reducedMotion;
	if (flag === "true") return true;
	if (flag === "false") return false;
	return defaultMatchMedia(MEDIA_QUERIES.reducedMotion)?.matches === true;
}

export function createThemeController(
	root: HTMLElement,
	options: { matchMedia?: MatchMedia } = {}
): ThemeController {
	const matchMedia = options.matchMedia ?? defaultMatchMedia;
	const lightQuery = matchMedia(MEDIA_QUERIES.light);
	const motionQuery = matchMedia(MEDIA_QUERIES.reducedMotion);
	let display: Pick<Settings["display"], "theme" | "reducedMotion"> = {
		theme: "dark",
		reducedMotion: "system",
	};
	let theme: ResolvedTheme = "dark";
	let reducedMotion = false;
	const listeners = new Set<(s: { theme: ResolvedTheme; reducedMotion: boolean }) => void>();

	function compute(): void {
		theme = display.theme === "system" ? (lightQuery?.matches ? "light" : "dark") : display.theme;
		reducedMotion =
			display.reducedMotion === "system"
				? motionQuery?.matches === true
				: display.reducedMotion === "on";
		root.dataset.theme = theme;
		root.dataset.reducedMotion = reducedMotion ? "true" : "false";
		for (const cb of [...listeners]) cb({ theme, reducedMotion });
	}

	const onMedia = (): void => compute();
	lightQuery?.addEventListener("change", onMedia);
	motionQuery?.addEventListener("change", onMedia);
	compute();

	return {
		get theme() {
			return theme;
		},
		get reducedMotion() {
			return reducedMotion;
		},
		apply(next) {
			display = { theme: next.theme, reducedMotion: next.reducedMotion };
			compute();
		},
		onChange(cb) {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		dispose() {
			lightQuery?.removeEventListener("change", onMedia);
			motionQuery?.removeEventListener("change", onMedia);
			listeners.clear();
		},
	};
}
