/**
 * Live game view (Part I §10.4, Appendix F §4.4–§4.5, §5.5–§5.10, §6.1–§6.3, §8.2). A pure
 * projection of `PanelSnapshot` plus local UI state (hover / pin / hold progress / layout):
 * eval rail and mirrored player rows, move card with the play button and countdown, PV lines,
 * strength card, toggles row, session strip. Every timer, observer and listener is disposed
 * by the cleanup the router runs before the next mount.
 *
 * Hands-off (§13.4 / §10.4 amendment): while `session.state` is a live state the view is
 * display-only — it locks every control itself (`aria-disabled` + `tabindex=-1`, the
 * `.sl-live--hands-off` class turns pointer events off) in addition to the shell's lock, the
 * Play button shows its keybind only, popovers close, keybinds in the panel are ignored (in-game
 * control is `chrome.commands` / the content script, with focus on the board), and the
 * detached banner is not raised (the shell's hands-off banner is the only one). No element is
 * ever focused programmatically.
 */

import { tabsQuery } from "@core/chrome/tabs";
import type { PanelSnapshot } from "@core/constants/messages";
import { MSG } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { log } from "@core/logger";
import type { TypedMessage } from "@core/messaging/typed-messages";
import { TOKENS } from "@design/tokens.generated";
import type { Keybind } from "@typedefs/settings";
import { type BannerHandle, showBanner } from "../components/banner";
import { createCountdownRing } from "../components/countdown-ring";
import { formatKeybind } from "../components/keybind";
import { closePopovers } from "../components/popover";
import { showToast, type ToastHandle, type ToastKind } from "../components/toast";
import { COPY, COPY_LIVE } from "../copy";
import { mountIcons } from "../icons-mount";
import { isHandsOff } from "../router";
import type { PanelCommandType } from "../store";
import { instantiate, part } from "../template";
import type { View, ViewContext } from "../view";
import {
	type CollapseState,
	collapseFor,
	type LayoutMetrics,
	measureLayout,
	observeLayout,
} from "./live/collapse";
import { createEvalSection } from "./live/eval-section";
import { createLinesSection } from "./live/lines-section";
import { createMoveSection } from "./live/move-section";
import { createSessionStrip } from "./live/session-strip";
import { createStrengthCard } from "./live/strength-card";
import { createTogglesRow } from "./live/toggles-row";
import liveHtml from "./templates/live.html?raw";

/** §8.1: compact shows at most two PV rows. */
const COMPACT_PV_MAX = 2;
/** The pre-arm toast's ring drains at the ring's own linear cadence (§5.10). */
const RING_TICK_MS = TOKENS.motion.durationMs[1];

interface SavedFocusable {
	ariaDisabled: string | null;
	tabindex: string | null;
}

/** Everything the hands-off lock covers inside the view (mirrors the shell's selector). */
const LOCK_SELECTOR =
	'a[href], button, input, select, textarea, [tabindex], [role="switch"], [role="slider"], [role="tab"]';

const TOAST_KIND: Readonly<Record<"info" | "warn" | "error", ToastKind>> = {
	info: "info",
	warn: "warn",
	error: "danger",
};

/** Whether a keydown is the given keybind (code or key, all four modifiers). */
export function matchesKeybind(event: KeyboardEvent, kb: Keybind): boolean {
	const keyMatch =
		(kb.code !== "" && event.code === kb.code) || event.key.toLowerCase() === kb.key.toLowerCase();
	return (
		keyMatch &&
		event.altKey === kb.altKey &&
		event.ctrlKey === kb.ctrlKey &&
		event.metaKey === kb.metaKey &&
		event.shiftKey === kb.shiftKey
	);
}

export const liveView: View = {
	mount(ctx: ViewContext) {
		return mountLive(ctx);
	},
};

function mountLive(ctx: ViewContext): () => void {
	const { store, container } = ctx;
	const doc = container.ownerDocument;
	const root = instantiate(liveHtml);
	const app = container.closest<HTMLElement>(".sl-app");
	let snapshot: PanelSnapshot | null = ctx.snapshot ?? store.snapshot;
	let handsOff = false;
	let disposed = false;
	let tabId: number | null = null;
	let metrics: LayoutMetrics = measureLayout(app);
	let collapse: CollapseState = collapseFor(metrics.availablePx, 1);
	let autoPlayUsed = false;
	let wasAttached = false;
	let detachedDismissed = false;
	let detachedBanner: BannerHandle | null = null;
	let preArmTimer: ReturnType<typeof setTimeout> | null = null;
	let preArmToast: ToastHandle | null = null;
	let preArmRing: ReturnType<typeof createCountdownRing> | null = null;
	let preArmTick: ReturnType<typeof setInterval> | null = null;
	/** Controls locked by hands-off with the attributes they had before (restored on exit). */
	const locked = new Map<Element, SavedFocusable>();

	// ── dispatch ────────────────────────────────────────────────────────────
	function send<T extends PanelCommandType>(command: TypedMessage<T>): Promise<boolean> {
		if (disposed) return Promise.resolve(false);
		return store.dispatch(command).then(
			() => true,
			(error: unknown) => {
				log.warn("live: dispatch failed", { type: command.type, error });
				return false;
			}
		);
	}

	function withTab<T extends PanelCommandType>(
		build: (tabId: number) => TypedMessage<T>
	): Promise<boolean> {
		if (tabId === null) {
			log.warn("live: no active tab for the command");
			return Promise.resolve(false);
		}
		return send(build(tabId));
	}

	// ── sections ────────────────────────────────────────────────────────────
	const evalSection = createEvalSection({
		rail: part(root, ".sl-live__rail"),
		opponentSlot: part(root, '.sl-live__row-slot[data-slot="opponent"]'),
		meSlot: part(root, '.sl-live__row-slot[data-slot="me"]'),
		evalRow: part(root, ".sl-live__eval"),
	});
	const moveSection = createMoveSection({
		host: part(root, ".sl-live__move"),
		onPlay: () => {
			if (handsOff) return;
			void withTab((id) => ({ type: MSG.PANEL_PLAY_NOW, tabId: id }));
		},
		onCancel: () => {
			if (handsOff) return;
			const san = moveSection.san ?? "";
			// The toast only once the SW confirmed the skip (§6.2 step 3).
			void withTab((id) => ({ type: MSG.PANEL_CANCEL_PENDING, tabId: id })).then((ok) => {
				if (ok && !disposed) showToast("info", COPY.toast.skipped(san));
			});
		},
	});
	const linesSection = createLinesSection({
		root: part(root, ".sl-live__lines"),
		onPreview: (multipv) => {
			if (handsOff) return;
			void withTab((id) => ({ type: MSG.PANEL_PREVIEW_LINE, tabId: id, multipv }));
		},
	});
	const strengthHost = part(root, ".sl-live__strength");
	const strength = createStrengthCard(strengthHost);
	const toggles = createTogglesRow({
		host: part(root, ".sl-live__toggles"),
		onAutoPlay: (armed) => void setAutoPlay(armed),
	});
	const stripHost = part(root, ".sl-live__strip");
	const strip = createSessionStrip(stripHost);
	mountIcons(root);

	// ── auto-play arming (§6.1) ─────────────────────────────────────────────
	async function setAutoPlay(armed: boolean): Promise<void> {
		if (handsOff || !snapshot) return;
		if (!armed && snapshot.autoMove.scheduledAt !== undefined)
			showToast("info", COPY.toast.disarmed(moveSection.san ?? ""));
		const ok = await withTab((id) => ({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: id, armed }));
		if (!ok && !disposed && snapshot) toggles.autoplay.update({ checked: snapshot.autoMove.armed });
	}

	function cancelPreArm(): void {
		if (preArmTimer !== null) {
			clearTimeout(preArmTimer);
			preArmTimer = null;
		}
		if (preArmTick !== null) {
			clearInterval(preArmTick);
			preArmTick = null;
		}
		preArmRing?.dispose();
		preArmRing = null;
		preArmToast?.dismiss();
		preArmToast = null;
	}

	/** §6.1 step 5: the keybind pre-arms with a 1 s cancel window; disarms instantly. */
	function onToggleKeybind(): void {
		if (!snapshot) return;
		if (snapshot.autoMove.armed) {
			cancelPreArm();
			void setAutoPlay(false);
			return;
		}
		if (preArmTimer !== null) {
			cancelPreArm();
			return;
		}
		preArmToast = showToast(
			"info",
			COPY.toast.preArm(formatKeybind(snapshot.settings.keybinds.toggleAutoMove)),
			{
				label: COPY_LIVE.cancel,
				onClick: cancelPreArm,
			}
		);
		// §6.1 step 5: the toast carries a ring that drains over the 1 s window.
		const startedAt = Date.now();
		preArmRing = createCountdownRing(null, { size: "sm" });
		preArmRing.update(UI_TIMINGS.preArmMs, UI_TIMINGS.preArmMs);
		preArmToast.el.insertBefore(preArmRing.el, preArmToast.el.querySelector(".sl-toast__text"));
		preArmTick = setInterval(() => {
			preArmRing?.update(
				Math.max(0, UI_TIMINGS.preArmMs - (Date.now() - startedAt)),
				UI_TIMINGS.preArmMs
			);
		}, RING_TICK_MS);
		preArmTimer = setTimeout(() => {
			preArmTimer = null;
			const toast = preArmToast;
			preArmToast = null;
			cancelPreArm();
			toast?.dismiss();
			void setAutoPlay(true);
		}, UI_TIMINGS.preArmMs);
	}

	const onKeyDown = (event: KeyboardEvent): void => {
		if (disposed || handsOff || !snapshot || event.defaultPrevented) return;
		const target = event.target;
		if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
		const { keybinds } = snapshot.settings;
		if (matchesKeybind(event, keybinds.toggleAutoMove)) {
			event.preventDefault();
			onToggleKeybind();
		} else if (matchesKeybind(event, keybinds.playMove)) {
			event.preventDefault();
			void withTab((id) => ({ type: MSG.PANEL_PLAY_NOW, tabId: id }));
		}
	};
	doc.addEventListener("keydown", onKeyDown);

	// ── hands-off lock (§13.4) ──────────────────────────────────────────────
	function lockControls(): void {
		for (const el of root.querySelectorAll(LOCK_SELECTOR)) {
			if (!locked.has(el))
				locked.set(el, {
					ariaDisabled: el.getAttribute("aria-disabled"),
					tabindex: el.getAttribute("tabindex"),
				});
			el.setAttribute("aria-disabled", "true");
			el.setAttribute("tabindex", "-1");
		}
	}

	/** Mirrors the shell: every control gets back exactly the attributes it had. */
	function unlockControls(): void {
		for (const [el, saved] of locked) {
			if (saved.ariaDisabled === null) el.removeAttribute("aria-disabled");
			else el.setAttribute("aria-disabled", saved.ariaDisabled);
			if (saved.tabindex === null) el.removeAttribute("tabindex");
			else el.setAttribute("tabindex", saved.tabindex);
		}
		locked.clear();
	}

	// ── detached banner (§4.4, §9.7) ────────────────────────────────────────
	function applyDetachedBanner(snap: PanelSnapshot): void {
		if (snap.executor.debuggerAttached) {
			detachedDismissed = false;
			detachedBanner?.dismiss();
			detachedBanner = null;
			return;
		}
		const detached = wasAttached || snap.session.hand === "detached";
		const wanted = detached && !handsOff && !detachedDismissed;
		if (wanted && !detachedBanner) {
			detachedBanner = showBanner(
				"warn",
				COPY.banner.detached,
				[
					{
						label: COPY.banner.reattach,
						onClick: () => {
							detachedDismissed = true;
							void withTab((id) => ({ type: MSG.PANEL_REATTACH_DEBUGGER, tabId: id }));
						},
					},
					{
						label: COPY.banner.dismiss,
						onClick: () => {
							detachedDismissed = true;
						},
					},
				],
				{ key: "detached" }
			);
		} else if (!wanted && detachedBanner) {
			detachedBanner.dismiss();
			detachedBanner = null;
		}
	}

	// ── layout (§8.2, §4.5) ─────────────────────────────────────────────────
	function computeCollapse(snap: PanelSnapshot): CollapseState {
		const setting = Math.max(1, snap.settings.display.pvCount);
		const pvCount = metrics.compact ? Math.min(setting, COMPACT_PV_MAX) : setting;
		return collapseFor(metrics.availablePx, pvCount);
	}

	// ── render ──────────────────────────────────────────────────────────────
	function render(): void {
		const snap = snapshot;
		if (!snap || disposed) return;
		const nextHandsOff = isHandsOff(snap);
		if (nextHandsOff !== handsOff) {
			handsOff = nextHandsOff;
			if (handsOff) {
				cancelPreArm();
				closePopovers();
			} else unlockControls();
		}
		root.classList.toggle("sl-live--hands-off", handsOff);
		collapse = computeCollapse(snap);
		root.dataset.collapse = collapse.name;
		root.classList.toggle("sl-live--compact", metrics.compact);
		root.classList.toggle("sl-live--scroll", collapse.scroll);
		if (snap.autoMove.armed || snap.executor.debuggerAttached) autoPlayUsed = true;
		if (snap.executor.debuggerAttached) wasAttached = true;

		evalSection.update({ snapshot: snap, inline: collapse.wdlFolded, compact: metrics.compact });
		moveSection.update({
			snapshot: snap,
			compact: metrics.compact || collapse.moveCompact,
			handsOff,
		});
		linesSection.update({
			snapshot: snap,
			pvMax: collapse.pvMax,
			compact: metrics.compact,
			showDepth: metrics.comfortable,
			handsOff,
		});
		strength.update({ snapshot: snap, handsOff });
		strengthHost.hidden = collapse.strengthChip;
		toggles.update({ snapshot: snap, handsOff, strengthChip: collapse.strengthChip });
		strip.update({ snapshot: snap, autoPlayUsed, wasAttached });
		stripHost.hidden = collapse.stripHidden;
		applyDetachedBanner(snap);
		if (handsOff) lockControls();
	}

	const stopLayout = observeLayout({
		app,
		onChange: (next) => {
			if (
				next.availablePx === metrics.availablePx &&
				next.compact === metrics.compact &&
				next.comfortable === metrics.comfortable
			)
				return;
			metrics = next;
			render();
		},
	});

	// ── store ───────────────────────────────────────────────────────────────
	const unsubscribe = store.subscribe((next) => {
		snapshot = next;
		render();
	});
	const unsubscribePort = store.onPortMessage((message) => {
		if (message.kind === "toast") showToast(TOAST_KIND[message.level], message.text);
	});

	tabsQuery({ active: true, currentWindow: true })
		.then((tabs) => {
			if (disposed) return;
			const id = tabs[0]?.id;
			tabId = typeof id === "number" ? id : null;
		})
		.catch((error: unknown) => log.warn("live: tabs.query failed", error));

	container.append(root);
	render();

	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		unsubscribePort();
		stopLayout();
		doc.removeEventListener("keydown", onKeyDown);
		cancelPreArm();
		detachedBanner?.dismiss();
		detachedBanner = null;
		closePopovers();
		evalSection.dispose();
		moveSection.dispose();
		linesSection.dispose();
		strength.dispose();
		toggles.dispose();
		strip.dispose();
		locked.clear();
		root.remove();
	};
}
