/**
 * Panel shell (Part I §10.4, Appendix F §3): top bar (brand · engine pill · view switch),
 * banner slot, content region (one view at a time), toast and overlay layers. The shell is a
 * projection of `PanelStore` snapshots: every snapshot re-applies theme, sound gating,
 * hands-off mode and re-resolves the view. Local UI state (`PanelUiState`) is the selected tab
 * and the update-interrupt dismissal; `Alt+1/2/3` switch tabs.
 *
 * Hands-off mode (§13.4): while a game is live the root carries `.sl-hands-off` (CSS turns
 * every interactive control to `pointer-events: none`), the content region is `aria-disabled`,
 * the view switch is disabled and the persistent banner explains why. The shell never calls
 * `focus()`, `alert()` or `autofocus`.
 */

import { chromeLocalGet, onStorageChanged } from "@core/chrome/storage";
import type { PanelSnapshot } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { installActionHandlers } from "./actions";
import { type BannerHandle, clearBanners, mountBannerSlot, showBanner } from "./components/banner";
import { createPill, type PillHandle, type PillVariant } from "./components/pill";
import { closePopovers, mountOverlayLayer } from "./components/popover";
import { createSegment, type SegmentHandle } from "./components/segment";
import { clearToasts, mountToastLayer } from "./components/toast";
import { COPY } from "./copy";
import { mountIcons } from "./icons-mount";
import { resetEscapeHandlers, viewSwitchIndex } from "./keys";
import { isHandsOff, PanelRouter } from "./router";
import { setUiSoundsEnabled } from "./sounds";
import type { PanelStore } from "./store";
import { instantiate, part } from "./template";
import { createThemeController, type MatchMedia, type ThemeController } from "./theme";
import {
	PANEL_TABS,
	type PanelTab,
	type PanelUiState,
	type ViewName,
	type ViewRegistry,
} from "./view";
import { VIEWS } from "./views";
import shellHtml from "./views/templates/shell.html?raw";

export interface ShellOptions {
	store: PanelStore;
	views?: Partial<ViewRegistry>;
	matchMedia?: MatchMedia;
	/** Called by the update banner's action (Task 27 wires the reload). */
	onUpdate?: () => void;
	/** Extension version for the update banner (defaults to the build define). */
	version?: string;
}

export interface PanelShell {
	readonly root: HTMLElement;
	readonly router: PanelRouter;
	readonly ui: Readonly<PanelUiState>;
	readonly theme: ThemeController;
	readonly handsOff: boolean;
	readonly snapshot: PanelSnapshot | null;
	setTab(tab: PanelTab): void;
	dismissUpdate(): void;
	dispose(): void;
}

const VIEWS_WITHOUT_TOPBAR: ReadonlySet<ViewName> = new Set(["login"]);

function enginePill(snapshot: PanelSnapshot): { variant: PillVariant; text: string } {
	const { engine } = snapshot;
	switch (engine.state) {
		case "searching":
			return {
				variant: "thinking",
				text: COPY.engine.thinking(snapshot.recommendation?.depth ?? 0),
			};
		case "ready":
			return { variant: "idle", text: COPY.engine.idle };
		case "crashed":
			return { variant: "danger", text: COPY.engine.stopped };
		default:
			return { variant: "idle", text: COPY.engine.loading };
	}
}

export function bootShell(root: HTMLElement, options: ShellOptions): PanelShell {
	const store = options.store;
	const doc = root.ownerDocument;
	const body = doc.body;
	root.classList.add("sl-app");
	root.replaceChildren(instantiate(shellHtml));
	const topbar = part(root, ".sl-topbar");
	part(root, ".sl-topbar__wordmark").textContent = COPY.brand.name;
	const statusHost = part(root, ".sl-topbar__status");
	const switchHost = part(root, ".sl-topbar__switch");
	const bannerSlot = part(root, ".sl-app__banner");
	const content = part(root, ".sl-app__content");
	const toastLayer = part(root, ".sl-app__toasts");
	const overlayLayer = part(root, ".sl-app__overlay");

	const ui: PanelUiState = { tab: "game", updateAvailable: false, updateDismissed: false };
	let snapshot: PanelSnapshot | null = null;
	let handsOff = false;
	let disposed = false;
	let handsOffBanner: BannerHandle | null = null;
	let updateBanner: BannerHandle | null = null;
	const version = options.version ?? __SL_VERSION__;

	const theme = createThemeController(
		body,
		options.matchMedia ? { matchMedia: options.matchMedia } : {}
	);
	const unmountToasts = mountToastLayer(toastLayer);
	const unmountOverlay = mountOverlayLayer(overlayLayer);
	const unmountBanners = mountBannerSlot(bannerSlot);

	const pill: PillHandle = createPill(statusHost, {
		variant: "idle",
		icon: "status.idle",
		text: COPY.engine.loading,
	});
	const viewSwitch: SegmentHandle<PanelTab> = createSegment<PanelTab>(switchHost, {
		items: [
			{ id: "game", label: COPY.nav.game, icon: "nav.game" },
			{ id: "settings", label: COPY.nav.settings, icon: "nav.settings" },
			{ id: "engine", label: COPY.nav.engine, icon: "nav.engine" },
		],
		value: ui.tab,
		ariaLabel: COPY.nav.viewSwitch,
		onChange: (tab) => setTab(tab),
	});
	mountIcons(root);

	const router = new PanelRouter(
		content,
		{ ...VIEWS, ...options.views },
		{
			store,
			onMounted: (name) => {
				topbar.hidden = VIEWS_WITHOUT_TOPBAR.has(name);
				clearToasts(); // §3.3: the toast queue is cleared on view change
				closePopovers();
			},
		}
	);

	function reresolve(): void {
		if (disposed || !snapshot) return;
		router.resolve(snapshot, ui).catch((error: unknown) => log.warn("shell: resolve failed", error));
	}

	function applyHandsOff(next: boolean): void {
		if (handsOff === next) return;
		handsOff = next;
		root.classList.toggle("sl-hands-off", next);
		if (next) content.setAttribute("aria-disabled", "true");
		else content.removeAttribute("aria-disabled");
		viewSwitch.update({ disabled: next });
		if (next) {
			handsOffBanner = showBanner("info", COPY.banner.handsOff, [], { key: "hands-off" });
		} else {
			handsOffBanner?.dismiss();
			handsOffBanner = null;
		}
	}

	function applyUpdateBanner(): void {
		const wanted = ui.updateAvailable && ui.updateDismissed;
		if (wanted && !updateBanner) {
			updateBanner = showBanner(
				"info",
				COPY.banner.update(version),
				[{ label: COPY.banner.updateAction, onClick: () => options.onUpdate?.(), keepOpen: true }],
				{ key: "update" }
			);
		} else if (!wanted && updateBanner) {
			updateBanner.dismiss();
			updateBanner = null;
		}
	}

	function setTab(tab: PanelTab): void {
		if (handsOff && tab !== ui.tab) return; // the view switch is disabled during a game
		ui.tab = tab;
		viewSwitch.update({ value: tab });
		reresolve();
	}

	function dismissUpdate(): void {
		ui.updateDismissed = true;
		applyUpdateBanner();
		reresolve();
	}

	function onSnapshot(next: PanelSnapshot): void {
		snapshot = next;
		theme.apply(next.settings.display);
		setUiSoundsEnabled(next.settings.display.uiSounds);
		const p = enginePill(next);
		pill.update({
			variant: p.variant,
			icon:
				p.variant === "thinking"
					? "status.thinking"
					: p.variant === "danger"
						? "status.detached"
						: "status.idle",
			text: p.text,
		});
		applyHandsOff(isHandsOff(next));
		reresolve();
	}

	const onKeyDown = (event: KeyboardEvent): void => {
		const index = viewSwitchIndex(event);
		if (index === null) return;
		const tab = PANEL_TABS[index];
		if (!tab) return;
		event.preventDefault();
		if (snapshot && VIEWS_WITHOUT_TOPBAR.has(router.current ?? "login")) return;
		setTab(tab);
	};
	doc.addEventListener("keydown", onKeyDown);

	const uninstallActions = installActionHandlers(root, {
		setTab,
		dismissUpdate,
		get handsOff() {
			return handsOff;
		},
	});

	const unsubscribe = store.subscribe(onSnapshot);

	// `LOCAL_KEYS.updateAvailable` is not part of the snapshot; mirror it from storage.
	chromeLocalGet(LOCAL_KEYS.updateAvailable)
		.then((flag) => {
			if (disposed) return;
			ui.updateAvailable = flag === true;
			applyUpdateBanner();
			reresolve();
		})
		.catch((error: unknown) => log.debug("shell: updateAvailable read failed", error));
	const unsubscribeStorage = onStorageChanged("local", (changes) => {
		const change = changes[LOCAL_KEYS.updateAvailable];
		if (!change) return;
		ui.updateAvailable = change.newValue === true;
		if (!ui.updateAvailable) ui.updateDismissed = false;
		applyUpdateBanner();
		reresolve();
	});

	return {
		root,
		router,
		ui,
		theme,
		get handsOff() {
			return handsOff;
		},
		get snapshot() {
			return snapshot;
		},
		setTab,
		dismissUpdate,
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			unsubscribeStorage();
			uninstallActions();
			doc.removeEventListener("keydown", onKeyDown);
			router.dispose();
			viewSwitch.dispose();
			pill.dispose();
			clearBanners();
			unmountBanners();
			unmountToasts();
			unmountOverlay();
			resetEscapeHandlers();
			theme.dispose();
			root.classList.remove("sl-app", "sl-hands-off");
			root.replaceChildren();
		},
	};
}
