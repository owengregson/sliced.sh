/**
 * Toggles row (Appendix F §4.4 item 8, §6.1): Auto-play (hold-to-arm 600 ms, single-click
 * disarm, danger grammar when armed), Highlight and Auto-queue (ordinary toggles →
 * `setSettings`). The strength chip of §8.2 step 4 ("1200 · Balanced") lives here, hidden until
 * the collapse state asks for it. Once per panel session: the arm-hold hint tooltip after an
 * early release and the debugger-infobar banner after the first arm (§6.1 steps 2–3).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { log } from "@core/logger";
import { setSettings } from "@core/storage/settings-storage";
import { type BannerHandle, showBanner } from "../../components/banner";
import { showTooltip, type TooltipHandle } from "../../components/popover";
import { createToggle, type ToggleHandle } from "../../components/toggle";
import { COPY, COPY_LIVE } from "../../copy";
import { instantiate, part } from "../../template";
import rowHtml from "../templates/live/toggles-row.html?raw";

export interface TogglesRowOptions {
	host: HTMLElement;
	/** Arm (`true`) / disarm (`false`) requested by the user. */
	onAutoPlay: (armed: boolean) => void;
}

export interface TogglesRowState {
	snapshot: PanelSnapshot;
	handsOff: boolean;
	/** §8.2 step 4: the strength card collapsed into this row. */
	strengthChip: boolean;
}

export interface TogglesRowHandle {
	readonly el: HTMLElement;
	readonly autoplay: ToggleHandle;
	update(state: TogglesRowState): void;
	dispose(): void;
}

/** Once-per-session flags (§6.1 steps 2 and 3); reset by tests. */
const session = { holdHintShown: false, debuggerBannerShown: false };

export function resetLiveSessionFlags(): void {
	session.holdHintShown = false;
	session.debuggerBannerShown = false;
}

export function createTogglesRow(options: TogglesRowOptions): TogglesRowHandle {
	const el = instantiate(rowHtml);
	const chip = part(el, ".sl-live__strength-chip");
	options.host.append(el);
	let hintTip: TooltipHandle | null = null;
	let hintTimer: ReturnType<typeof setTimeout> | null = null;
	let banner: BannerHandle | null = null;

	function hideHint(): void {
		if (hintTimer !== null) {
			clearTimeout(hintTimer);
			hintTimer = null;
		}
		hintTip?.close();
		hintTip = null;
	}

	const autoplay = createToggle(part(el, '[data-toggle-slot="autoplay"]'), {
		label: COPY.toggle.autoplay,
		icon: "toggle.autoplay",
		checked: false,
		armed: true,
		onChange: (armed) => {
			if (armed && !session.debuggerBannerShown) {
				session.debuggerBannerShown = true;
				banner = showBanner(
					"warn",
					COPY.banner.debugger,
					[{ label: COPY.banner.gotIt, onClick: () => {} }],
					{ key: "debugger" }
				);
			}
			options.onAutoPlay(armed);
		},
		onHoldCancelled: () => {
			if (session.holdHintShown) return;
			session.holdHintShown = true;
			hideHint();
			hintTip = showTooltip(autoplay.el, COPY.toggle.armTooltip);
			hintTimer = setTimeout(hideHint, UI_TIMINGS.toastLongMs);
		},
	});
	autoplay.el.dataset.toggle = "autoplay";

	const highlight = createToggle(part(el, '[data-toggle-slot="highlight"]'), {
		label: COPY.toggle.highlight,
		icon: "toggle.highlight",
		checked: false,
		onChange: (on) => {
			setSettings({ automation: { highlightMoves: on } }).catch((error: unknown) =>
				log.warn("live: highlight write failed", error)
			);
		},
	});
	highlight.el.dataset.toggle = "highlight";

	const autoqueue = createToggle(part(el, '[data-toggle-slot="autoqueue"]'), {
		label: COPY.toggle.autoqueue,
		icon: "toggle.autoqueue",
		checked: false,
		onChange: (on) => {
			setSettings({ automation: { autoQueue: on } }).catch((error: unknown) =>
				log.warn("live: auto-queue write failed", error)
			);
		},
	});
	autoqueue.el.dataset.toggle = "autoqueue";

	function update(state: TogglesRowState): void {
		const snap = state.snapshot;
		const { strength, automation } = snap.settings;
		autoplay.update({ checked: snap.autoMove.armed, disabled: state.handsOff });
		highlight.update({ checked: automation.highlightMoves, disabled: state.handsOff });
		autoqueue.update({ checked: automation.autoQueue, disabled: state.handsOff });
		chip.textContent = COPY_LIVE.strength.chip(
			snap.opponent?.derivedTargetElo ?? strength.targetElo,
			COPY.personaName[strength.persona]
		);
		chip.hidden = !state.strengthChip;
		if (state.handsOff) hideHint();
	}

	return {
		el,
		autoplay,
		update,
		dispose() {
			hideHint();
			banner?.dismiss();
			banner = null;
			autoplay.dispose();
			highlight.dispose();
			autoqueue.dispose();
			el.remove();
		},
	};
}
