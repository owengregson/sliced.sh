/**
 * SPA router for the side panel (Part I §10.4, Appendix H.6).
 *
 * `resolveView` is the pure projection `PanelSnapshot × PanelUiState → ViewName`, evaluated in
 * the binding rule order: `login` when there is no usable license; `expired` for
 * `invalid | expired | ip_limit`; `update` when the flag is set and no game is live;
 * `unsupported` when `site === null`; `waiting` when no game is live; `live`; the view switch
 * (`settings` / `engine`) is local UI state available during play. `PanelRouter`
 * mounts one `View` at a time and runs the previous cleanup before the next mount.
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { log } from "@core/logger";
import { ANIM } from "./animation-manager";
import type { PanelStore } from "./store";
import type {
	Cleanup,
	PanelUiState,
	Router,
	Transition,
	ViewContext,
	ViewName,
	ViewRegistry,
} from "./view";

const INTERRUPT_STATUSES: ReadonlySet<PanelSnapshot["license"]["status"]> = new Set([
	"invalid",
	"expired",
	"ip_limit",
]);

/** `session.state` is one of the `live:*` sub-states (§3.3). */
export function isLiveGame(snapshot: PanelSnapshot): boolean {
	return snapshot.session.state.startsWith("live:");
}

/** Panel controls remain available during play; the game owns its own focus/input policy. */
export function isHandsOff(_snapshot: PanelSnapshot): boolean {
	return false;
}

export function resolveView(snapshot: PanelSnapshot, ui: PanelUiState): ViewName {
	const status = snapshot.license.status;
	const live = isLiveGame(snapshot);
	if (INTERRUPT_STATUSES.has(status)) {
		// Expired (8) has no dismiss; only Settings › Account stays reachable via the top bar.
		return ui.tab === "settings" ? "settings" : "expired";
	}
	if (status !== "valid") return "login";
	if (ui.updateAvailable && !ui.updateDismissed && !live) return "update";
	if (ui.tab === "settings") return "settings";
	if (ui.tab === "engine") return "engine";
	if (live) return "live";
	if (snapshot.site === null) return "unsupported";
	return "waiting";
}

interface MountedView {
	name: ViewName;
	cleanup: Cleanup;
	controller: AbortController;
}

export interface RouterOptions {
	store?: PanelStore;
	/** Called after every successful mount (the shell updates the top bar / banner). */
	onMounted?: (name: ViewName) => void;
}

export class PanelRouter implements Router {
	private readonly container: HTMLElement;
	private readonly views: Partial<ViewRegistry>;
	private readonly options: RouterOptions;
	private mounted: MountedView | null = null;
	private lastSnapshot: PanelSnapshot | null = null;
	private lastUi: PanelUiState | null = null;
	private switching: Promise<void> = Promise.resolve();
	private disposed = false;
	private mountingController: AbortController | null = null;

	constructor(container: HTMLElement, views: Partial<ViewRegistry>, options: RouterOptions = {}) {
		this.container = container;
		this.views = views;
		this.options = options;
	}

	get current(): ViewName | null {
		return this.mounted?.name ?? null;
	}

	async resolve(snapshot: PanelSnapshot, ui: PanelUiState): Promise<void> {
		this.lastSnapshot = snapshot;
		this.lastUi = ui; // the live object: views read `ctx.ui.tab` etc. as it changes
		const target = resolveView(snapshot, ui);
		await this.switch(target, { transition: transitionFor(this.current, target) });
	}

	switch(name: ViewName, options: { transition?: Transition } = {}): Promise<void> {
		// Serialise switches so a burst of snapshots never interleaves mounts.
		// A shell hook/cleanup failure must not poison every later switch: the engine
		// keeps running independently, so recovery on the next snapshot is essential.
		this.switching = this.switching
			.catch((error: unknown) => log.warn("panel router: recovering after failed switch", { error }))
			.then(() => this.doSwitch(name, options));
		return this.switching;
	}

	private async doSwitch(name: ViewName, options: { transition?: Transition }): Promise<void> {
		if (this.disposed || this.mounted?.name === name) return;
		const view = this.views[name];
		if (!view) {
			log.warn("panel router: unknown view", { name });
			return;
		}
		this.unmount();
		this.container.replaceChildren();

		const controller = new AbortController();
		this.mountingController = controller;
		const store = this.options.store;
		const ctx: ViewContext = {
			router: this,
			container: this.container,
			get store() {
				return store ?? missingStore();
			},
			snapshot: this.lastSnapshot,
			ui: this.lastUi ?? { tab: "game", updateAvailable: false, updateDismissed: false },
			signal: controller.signal,
		};
		let cleanup: Cleanup;
		try {
			cleanup = await view.mount(ctx);
		} catch (error) {
			log.error("panel router: mount failed", { name, error });
			controller.abort();
			return;
		}
		this.mountingController = null;
		if (this.disposed || controller.signal.aborted) {
			cleanup();
			this.container.replaceChildren();
			return;
		}
		this.mounted = { name, cleanup, controller };
		this.container.dataset.view = name;
		enter(this.container, options.transition);
		this.options.onMounted?.(name);
		log.debug("panel router: mounted", { name });
	}

	private unmount(): void {
		const prev = this.mounted;
		if (!prev) return;
		this.mounted = null;
		try {
			prev.cleanup();
		} catch (error) {
			log.warn("panel router: cleanup threw", { name: prev.name, error });
		}
		prev.controller.abort();
	}

	/** Unmount the current view and drop its DOM. */
	dispose(): void {
		this.disposed = true;
		this.mountingController?.abort();
		this.mountingController = null;
		this.unmount();
		this.container.replaceChildren();
		delete this.container.dataset.view;
	}
}

const TAB_ORDER: Partial<Record<ViewName, number>> = {
	unsupported: 0,
	waiting: 0,
	live: 0,
	settings: 1,
	engine: 2,
};

/** Appendix F §3.2: tab-to-tab slides in tab order; interrupts rise; sub-states crossfade. */
export function transitionFor(from: ViewName | null, to: ViewName): Transition {
	if (to === "update" || to === "expired") return "rise";
	const a = from === null ? undefined : TAB_ORDER[from];
	const b = TAB_ORDER[to];
	if (a === undefined || b === undefined || a === b) return "crossfade";
	return b > a ? "slide-left" : "slide-right";
}

function enter(container: HTMLElement, transition: Transition | undefined): void {
	const el = container.firstElementChild;
	if (!(el instanceof HTMLElement) || !transition) return;
	switch (transition) {
		case "crossfade":
			void ANIM.fade(el, "in");
			return;
		case "slide-left":
			void ANIM.slide(el, "left");
			return;
		case "slide-right":
			void ANIM.slide(el, "right");
			return;
		case "rise":
			void ANIM.rise(el);
			return;
	}
}

function missingStore(): PanelStore {
	throw new Error("panel router: no store configured");
}
