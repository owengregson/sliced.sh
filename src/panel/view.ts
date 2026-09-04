/**
 * SPA shell view contract (Appendix H.6, adapted for the snapshot-driven panel of §10.4).
 *
 * Each view is a module exposing a `View` whose `mount` receives a `ViewContext` and returns a
 * cleanup that tears down listeners and pending work before the next view mounts. View
 * selection is a pure projection of `PanelSnapshot` + the local `PanelUiState` (`router.ts`).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import type { PanelStore } from "./store";

export const VIEW_NAMES = [
	"login",
	"expired",
	"unsupported",
	"waiting",
	"live",
	"settings",
	"engine",
	"update",
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

/** The three segments of the top-bar view switch (Appendix F §3.1). */
export type PanelTab = "game" | "settings" | "engine";

export const PANEL_TABS: readonly PanelTab[] = ["game", "settings", "engine"];

/** Local UI state that is not part of the SW snapshot (Appendix F §3.3 "memory" rows). */
export interface PanelUiState {
	tab: PanelTab;
	/** `LOCAL_KEYS.updateAvailable` mirrored by the shell. */
	updateAvailable: boolean;
	/** "Later" on the update interrupt: it then re-shows as an info banner instead. */
	updateDismissed: boolean;
}

export type Transition = "crossfade" | "slide-left" | "slide-right" | "rise";

export interface Router {
	/** Mount the named view (no-op when already mounted). */
	switch(name: ViewName, options?: { transition?: Transition }): Promise<void>;
	/** Resolve the view for a snapshot + ui state and mount it. */
	resolve(snapshot: PanelSnapshot, ui: PanelUiState): Promise<void>;
	/** Currently mounted view name (or null before the first resolve). */
	readonly current: ViewName | null;
}

export interface ViewContext {
	router: Router;
	container: HTMLElement;
	store: PanelStore;
	/** The snapshot the view was mounted with (views subscribe to `store` for updates). */
	snapshot: PanelSnapshot | null;
	/** The shell's live UI state object (mutated in place; never a copy). */
	ui: PanelUiState;
	/** Aborted when the view is unmounted. Views should honour this for async work. */
	signal: AbortSignal;
}

export type Cleanup = () => void;

export interface View {
	mount(ctx: ViewContext): Cleanup | Promise<Cleanup>;
}

export type ViewRegistry = Record<ViewName, View>;
