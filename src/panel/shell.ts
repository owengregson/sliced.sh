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
 */

import { chromeLocalGet, onStorageChanged } from "@core/chrome/storage";
import type { PanelSnapshot } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { mountLiveRegions } from "./a11y";
import { installActionHandlers } from "./actions";
import { type BannerHandle, clearBanners, mountBannerSlot, showBanner } from "./components/banner";
import { createPill, type PillHandle, type PillVariant } from "./components/pill";
import { closePopovers, mountOverlayLayer } from "./components/popover";
import { createSegment, type SegmentHandle } from "./components/segment";
import { clearToasts, mountToastLayer } from "./components/toast";
import { COPY } from "./copy";
import { mountIcons } from "./icons-mount";
import { installPanelKeybinds } from "./keybinds";
import { resetEscapeHandlers, viewSwitchIndex } from "./keys";
import { isHandsOff, isLiveGame, PanelRouter } from "./router";
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

/** Everything a keyboard could activate inside the content while hands-off (§13.4). */
const FOCUSABLE_SELECTOR =
	'a[href], button, input, select, textarea, [tabindex], [role="switch"], [role="slider"], [role="tab"]';
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([
	"Enter",
	" ",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

interface SavedFocusable {
	ariaDisabled: string | null;
	tabindex: string | null;
}

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
	let updateBanner: BannerHandle | null = null;
	const version = options.version ?? __SL_VERSION__;

	const theme = createThemeController(
		body,
		options.matchMedia ? { matchMedia: options.matchMedia } : {}
	);
	const unmountToasts = mountToastLayer(toastLayer);
	const unmountOverlay = mountOverlayLayer(overlayLayer);
	const unmountBanners = mountBannerSlot(bannerSlot);
	const unmountLive = mountLiveRegions(liveHost); // §7.4 `announce()` target

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
		onChange: (tab) => {
			playUiSound("navigate");
			setTab(tab);
		},
	});
	mountIcons(root);

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
				lockFocusables(); // a view mounted while hands-off starts disabled
			},
		}
	);

	function reresolve(): void {
		if (disposed || !snapshot) return;
		router.resolve(snapshot, ui).catch((error: unknown) => log.warn("shell: resolve failed", error));
	}

	// ── hands-off (§13.4): pointer (CSS), keyboard (capture guard) and AT (aria/tabindex) ──
	const lockedFocusables = new Map<Element, SavedFocusable>();
	let focusObserver: MutationObserver | null = null;

	function lockFocusables(): void {
		if (!handsOff) return;
		for (const el of content.querySelectorAll(FOCUSABLE_SELECTOR)) {
			if (lockedFocusables.has(el)) continue;
			lockedFocusables.set(el, {
				ariaDisabled: el.getAttribute("aria-disabled"),
				tabindex: el.getAttribute("tabindex"),
			});
			el.setAttribute("aria-disabled", "true");
			el.setAttribute("tabindex", "-1");
		}
	}

	function unlockFocusables(): void {
		for (const [el, saved] of lockedFocusables) {
			if (saved.ariaDisabled === null) el.removeAttribute("aria-disabled");
			else el.setAttribute("aria-disabled", saved.ariaDisabled);
			if (saved.tabindex === null) el.removeAttribute("tabindex");
			else el.setAttribute("tabindex", saved.tabindex);
		}
		lockedFocusables.clear();
	}

	const keyboardGuard = (event: KeyboardEvent): void => {
		if (!handsOff || !ACTIVATION_KEYS.has(event.key)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	content.addEventListener("keydown", keyboardGuard, true);
	content.addEventListener("keyup", keyboardGuard, true);
	// A control added after the lock (before the observer delivers) is locked the moment it is
	// focused, so Tab + Enter can never activate it.
	const focusGuard = (): void => lockFocusables();
	content.addEventListener("focusin", focusGuard, true);

	function applyHandsOff(next: boolean): void {
		if (handsOff === next) return;
		handsOff = next;
		root.classList.toggle("sl-hands-off", next);
		viewSwitch.update({ disabled: next });
		if (next) {
			content.setAttribute("aria-disabled", "true");
			lockFocusables();
			if (typeof MutationObserver === "function") {
				focusObserver = new MutationObserver(() => lockFocusables());
				focusObserver.observe(content, { childList: true, subtree: true });
			}
			closePopovers(); // an open popover (e.g. a confirm) must not act mid-game
			// The hands-off banner outranks every other banner; the update banner is suspended.
			updateBanner?.dismiss();
			updateBanner = null;
			handsOffBanner = showBanner("hands-off", COPY.banner.handsOff, [], { key: "hands-off" });
		} else {
			content.removeAttribute("aria-disabled");
			focusObserver?.disconnect();
			focusObserver = null;
			unlockFocusables();
			handsOffBanner?.dismiss();
			handsOffBanner = null;
			applyUpdateBanner();
		}
	}

	function applyUpdateBanner(): void {
		const wanted = ui.updateAvailable && ui.updateDismissed && !(snapshot && isLiveGame(snapshot));
		if (wanted && !updateBanner) {
			updateBanner = showBanner(
				"info",
				COPY.banner.update(version),
				[
					{
						label: COPY.banner.updateAction,
						onClick: () => {
							if (snapshot && isLiveGame(snapshot)) return; // Defer extension reload until the game ends.
							options.onUpdate?.();
						},
						keepOpen: true,
					},
				],
				{ key: "update" }
			);
		} else if (!wanted && updateBanner) {
			updateBanner.dismiss();
			updateBanner = null;
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
		applyUpdateBanner();
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
			uninstallKeybinds();
			doc.removeEventListener("keydown", onKeyDown);
			content.removeEventListener("keydown", keyboardGuard, true);
			content.removeEventListener("keyup", keyboardGuard, true);
			content.removeEventListener("focusin", focusGuard, true);
			focusObserver?.disconnect();
			focusObserver = null;
			lockedFocusables.clear();
			router.dispose();
			viewSwitch.dispose();
			pill.dispose();
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
