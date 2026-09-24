/**
 * Panel shell (Part I §10.4, Appendix F §3): top bar (brand · engine pill · view switch),
 * banner slot, content region (one view at a time), toast and overlay layers. The shell is a
 * projection of `PanelStore` snapshots: every snapshot re-applies theme, sound gating,
 * hands-off mode and re-resolves the view. Local UI state (`PanelUiState`) is the selected tab
 * and the update-interrupt dismissal; `Alt+1/2/3` switch tabs.
 *
 * Hands-off mode (§13.4): while a game is live the root carries `.sl-hands-off` (CSS turns
 * every interactive control to `pointer-events: none`), a capture-phase keyboard guard on the
 * content swallows activation keys, every focusable in the content gets `aria-disabled="true"`
 * + `tabindex="-1"` (restored on exit; a MutationObserver covers views mounted meanwhile), the
 * view switch is disabled, the update banner is suspended and the top-ranked hands-off banner
 * explains why. The shell never calls `focus()`, `alert()` or `autofocus`. The `aria-live`
 * regions `announce()` writes into (`a11y.ts`) are mounted last in the shell.
 *
 * This file is the composition root; the top bar controls, the focus lock and the update banner
 * live in `shell/`.
 */

import { chromeLocalGet, onStorageChanged } from "@core/chrome/storage";
import type { PanelSnapshot } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { mountLiveRegions } from "./a11y";
import { installActionHandlers } from "./actions";
import { type BannerHandle, clearBanners, mountBannerSlot, showBanner } from "./components/banner";
import { closePopovers, mountOverlayLayer } from "./components/popover";
import { clearToasts, mountToastLayer } from "./components/toast";
import { COPY } from "./copy";
import { mountIcons } from "./icons-mount";
import { installPanelKeybinds } from "./keybinds";
import { resetEscapeHandlers, viewSwitchIndex } from "./keys";
import { isHandsOff, PanelRouter } from "./router";
import { createFocusLock } from "./shell/focus-lock";
import { createTopbar } from "./shell/topbar";
import { createUpdateBanner } from "./shell/update-banner";
import { playUiSound, setUiSoundsEnabled } from "./sounds";
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

export function bootShell(root: HTMLElement, options: ShellOptions): PanelShell {
	const store = options.store;
	const doc = root.ownerDocument;
	const body = doc.body;
	root.classList.add("sl-app");
	root.replaceChildren(instantiate(shellHtml));
	const topbar = part(root, ".sl-topbar");
	part(root, ".sl-topbar__wordmark").textContent = COPY.brand.product;
	part(root, ".sl-startup__title").textContent = COPY.workspace.connecting;
	part(root, ".sl-startup__body").textContent = COPY.workspace.connectingBody;
	const statusHost = part(root, ".sl-topbar__status");
	const switchHost = part(root, ".sl-topbar__switch");
	switchHost.setAttribute("aria-label", COPY.nav.viewSwitch);
	const bannerSlot = part(root, ".sl-app__banner");
	const content = part(root, ".sl-app__content");
	const toastLayer = part(root, ".sl-app__toasts");
	const overlayLayer = part(root, ".sl-app__overlay");
	const liveHost = part(root, ".sl-app__live");

	const ui: PanelUiState = { tab: "game", updateAvailable: false, updateDismissed: false };
	let snapshot: PanelSnapshot | null = null;
	let handsOff = false;
	let disposed = false;
	let handsOffBanner: BannerHandle | null = null;
	const updateBanner = createUpdateBanner({
		ui,
		snapshot: () => snapshot,
		version: options.version ?? __SL_VERSION__,
		onUpdate: options.onUpdate,
	});

	const theme = createThemeController(
		body,
		options.matchMedia ? { matchMedia: options.matchMedia } : {}
	);
	const unmountToasts = mountToastLayer(toastLayer);
	const unmountOverlay = mountOverlayLayer(overlayLayer);
	const unmountBanners = mountBannerSlot(bannerSlot);
	const unmountLive = mountLiveRegions(liveHost); // §7.4 `announce()` target

	const topbarControls = createTopbar(statusHost, switchHost, {
		tab: ui.tab,
		onSelect: (tab) => {
			playUiSound("navigate");
			setTab(tab);
		},
	});
	const viewSwitch = topbarControls.viewSwitch;
	mountIcons(root);

	// ── hands-off (§13.4): pointer (CSS), keyboard (capture guard) and AT (aria/tabindex) ──
	const focusLock = createFocusLock(content);

	const router = new PanelRouter(
		content,
		{ ...VIEWS, ...options.views },
		{
			store,
			onMounted: (name) => {
				topbar.hidden = VIEWS_WITHOUT_TOPBAR.has(name);
				content.removeAttribute("aria-busy");
				viewSwitch.update({
					value: name === "live" || name === "waiting" || name === "unsupported" ? "game" : ui.tab,
				});
				clearToasts(); // §3.3: the toast queue is cleared on view change
				closePopovers();
				focusLock.lockNew(); // a view mounted while hands-off starts disabled
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
		viewSwitch.update({ disabled: next });
		if (next) {
			focusLock.engage();
			closePopovers(); // an open popover (e.g. a confirm) must not act mid-game
			// The hands-off banner outranks every other banner; the update banner is suspended.
			updateBanner.suspend();
			handsOffBanner = showBanner("hands-off", COPY.banner.handsOff, [], { key: "hands-off" });
		} else {
			focusLock.release();
			handsOffBanner?.dismiss();
			handsOffBanner = null;
			updateBanner.apply();
		}
	}

	function setTab(tab: PanelTab): void {
		if (handsOff) return; // every navigation request is inert during a game
		ui.tab = tab;
		viewSwitch.update({ value: tab });
		reresolve();
	}

	function dismissUpdate(): void {
		ui.updateDismissed = true;
		updateBanner.apply();
		reresolve();
	}

	function onSnapshot(next: PanelSnapshot): void {
		snapshot = next;
		theme.apply(next.settings.display);
		setUiSoundsEnabled(next.settings.display.uiSounds);
		topbarControls.renderEngine(next);
		applyHandsOff(isHandsOff(next));
		updateBanner.apply();
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
	const uninstallKeybinds = installPanelKeybinds(doc, store);

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
			updateBanner.apply();
			reresolve();
		})
		.catch((error: unknown) => log.debug("shell: updateAvailable read failed", error));
	const unsubscribeStorage = onStorageChanged("local", (changes) => {
		const change = changes[LOCAL_KEYS.updateAvailable];
		if (!change) return;
		ui.updateAvailable = change.newValue === true;
		if (!ui.updateAvailable) ui.updateDismissed = false;
		updateBanner.apply();
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
			uninstallKeybinds();
			doc.removeEventListener("keydown", onKeyDown);
			focusLock.dispose();
			router.dispose();
			topbarControls.dispose();
			clearBanners();
			unmountBanners();
			unmountToasts();
			unmountOverlay();
			unmountLive();
			resetEscapeHandlers();
			theme.dispose();
			root.classList.remove("sl-app", "sl-hands-off");
			root.replaceChildren();
		},
	};
}
