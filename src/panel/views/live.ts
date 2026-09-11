/** Live scoreboard, move progress, analysis, and controls. Shortcuts are owned by the shell. */

import { tabsQuery } from "@core/chrome/tabs";
import type { PanelSnapshot } from "@core/constants/messages";
import { MSG } from "@core/constants/messages";
import { TOAST_KEYS } from "@core/constants/toasts";
import { log } from "@core/logger";
import type { TypedMessage } from "@core/messaging/typed-messages";
import { TOKENS } from "@design/tokens.generated";
import type { Keybind } from "@typedefs/settings";
import { type BannerHandle, showBanner } from "../components/banner";
import { formatKeybind } from "../components/keybind";
import { closePopovers } from "../components/popover";
import { showToast, type ToastKind } from "../components/toast";
import { COPY, COPY_LIVE } from "../copy";
import { mountIcons } from "../icons-mount";
import type { PanelCommandType } from "../store";
import { instantiate, part } from "../template";
import { portToastText } from "../toast-text";
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
import { createMoveSection, moveProgressPhase } from "./live/move-section";
import { createSessionStrip } from "./live/session-strip";
import { createStrengthCard } from "./live/strength-card";
import { createTogglesRow } from "./live/toggles-row";
import liveHtml from "./templates/live.html?raw";

/** §8.1: compact shows at most two PV rows. */
const COMPACT_PV_MAX = 2;
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
	const root = instantiate(liveHtml);
	const app = container.closest<HTMLElement>(".sl-app");
	part(root, ".sl-live__eyebrow").textContent = COPY.workspace.live;
	part(root, ".sl-shortcuts__title").textContent = COPY.workspace.shortcuts;
	part(root, ".sl-live__secondary-title").textContent = COPY_LIVE.secondary;
	for (const [action, label] of Object.entries({
		playMove: COPY.workspace.playNow,
		toggleAutoMove: COPY.workspace.autoPlay,
		disable: COPY.workspace.stop,
	}))
		part(root, `[data-shortcut="${action}"] span`).textContent = label;
	let snapshot: PanelSnapshot | null = ctx.snapshot ?? store.snapshot;
	const handsOff = false;
	let disposed = false;
	let tabId: number | null = null;
	let metrics: LayoutMetrics = measureLayout(app);
	let collapse: CollapseState = collapseFor(metrics.availablePx, 1);
	let autoPlayUsed = false;
	let wasAttached = false;
	let detachedDismissed = false;
	let detachedBanner: BannerHandle | null = null;

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
		const extraHeight =
			part(root, ".sl-live__heading").offsetHeight + part(root, ".sl-shortcuts").offsetHeight;
		const extraBudget = extraHeight > 0 ? extraHeight + TOKENS.space[5] * 2 : 0;
		return collapseFor(metrics.availablePx - extraBudget, pvCount);
	}

	// ── render ──────────────────────────────────────────────────────────────
	function render(): void {
		const snap = snapshot;
		if (!snap || disposed) return;
		metrics = measureLayout(app); // cheap; a banner can appear without any resize
		const phase = moveProgressPhase(snap);
		const phaseTitle = part(root, ".sl-live__title");
		if (phaseTitle.textContent !== COPY.move.progress[phase].title)
			phaseTitle.textContent = COPY.move.progress[phase].title;
		root.dataset.phase = phase;
		const configuration = part(root, ".sl-live__configuration");
		configuration.textContent = COPY_LIVE.configuration(
			snap.settings.automation.highlightMoves,
			snap.settings.automation.autoQueue
		);
		configuration.hidden = true;
		const automationStatus = part(root, ".sl-live__automation");
		automationStatus.textContent = snap.autoMove.armed ? COPY.toggle.armed : COPY.toggle.off;
		automationStatus.dataset.armed = String(snap.autoMove.armed);
		for (const action of ["playMove", "toggleAutoMove", "disable"] as const)
			part(root, `[data-shortcut="${action}"] kbd`).textContent = formatKeybind(
				snap.settings.keybinds[action]
			);
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
		strengthHost.hidden = false;
		toggles.update({ snapshot: snap, handsOff, strengthChip: false });
		strip.update({ snapshot: snap, autoPlayUsed, wasAttached });
		stripHost.hidden = false;
		applyDetachedBanner(snap);
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
		if (message.kind === "toast" && message.key !== TOAST_KEYS.played)
			showToast(TOAST_KIND[message.level], portToastText(message));
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
		detachedBanner?.dismiss();
		detachedBanner = null;
		closePopovers();
		evalSection.dispose();
		moveSection.dispose();
		linesSection.dispose();
		strength.dispose();
		toggles.dispose();
		strip.dispose();
		root.remove();
	};
}
