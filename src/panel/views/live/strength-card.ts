/**
 * Strength card (Appendix F §4.4 item 7, §5.12): one row — big Elo in `numeral-sm`, band label
 * in `body`, a chevron that opens a popover anchored to the card with the rating slider. Changes
 * apply immediately through `setSettings`; the footer says "Applies from next move". The card
 * itself follows the snapshot (never the popover's local value), so the SW's normalised settings
 * win. The persona chips and the selection-mode segment the popover used to carry are gone: both
 * settings are forced (`FORCED_SETTING_VALUES`, owner 2026-09-12).
 */

import { LIMITS } from "@core/constants/limits";
import type { PanelSnapshot } from "@core/constants/messages";
import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import { log } from "@core/logger";
import { type SettingsPatch, setSettings } from "@core/storage/settings-storage";
import type { Settings } from "@typedefs/settings";
import { openPopover, type PopoverHandle } from "../../components/popover";
import { createSlider, type SliderHandle, type SliderUpdate } from "../../components/slider";
import {
	STRENGTH_NETWORK_THRESHOLD,
	strengthBandLabel,
	strengthLabel,
} from "../../components/strength-threshold";
import { COPY, COPY_LIVE } from "../../copy";
import { mountIcons } from "../../icons-mount";
import { instantiate, part } from "../../template";
import cardHtml from "../templates/live/strength-card.html?raw";
import popoverHtml from "../templates/live/strength-popover.html?raw";

const SLIDER_STEP = STRENGTH_UI.sliderStep;

/**
 * What the popover's slider shows: the stored target, or — while opponent matching is on — the Elo
 * actually being played, as an exact reading on a disabled slider (owner, 2026-09-15; the
 * Settings row follows the same rule).
 */
function sliderReading(
	strength: Settings["strength"],
	activeElo: number
): Required<Pick<SliderUpdate, "value" | "exact" | "disabled">> {
	return strength.matchOpponentRating
		? { value: activeElo, exact: true, disabled: true }
		: { value: strength.targetElo, exact: false, disabled: false };
}

export interface StrengthCardState {
	snapshot: PanelSnapshot;
	handsOff: boolean;
}

export interface StrengthCardHandle {
	readonly el: HTMLElement;
	readonly open: boolean;
	update(state: StrengthCardState): void;
	dispose(): void;
}

function write(patch: SettingsPatch): void {
	setSettings(patch).catch((error: unknown) => log.warn("live: strength write failed", error));
}

export function createStrengthCard(host: HTMLElement): StrengthCardHandle {
	const el = instantiate(cardHtml);
	part(el, ".sl-live__strength-title").textContent = COPY_LIVE.strength.header;
	const elo = part(el, ".sl-live__strength-elo");
	const label = part(el, ".sl-live__strength-label");
	const open = part<HTMLButtonElement>(el, ".sl-live__strength-open");
	open.setAttribute("aria-label", COPY_LIVE.strength.header);
	mountIcons(el);
	host.append(el);

	let strength: Settings["strength"] | null = null;
	/** The session's derived target, else the stored one (what the card shows). */
	let activeElo: number | null = null;
	let handsOff = false;
	let popover: PopoverHandle | null = null;
	let slider: SliderHandle | null = null;

	function closePopover(): void {
		popover?.close();
		popover = null;
		syncExpanded();
	}

	function syncExpanded(): void {
		open.setAttribute("aria-expanded", popover?.open ? "true" : "false");
	}

	function disposeContent(): void {
		slider?.dispose();
		slider = null;
	}

	function openStrength(): void {
		if (!strength) return;
		const content = instantiate(popoverHtml);
		const reading = sliderReading(strength, activeElo ?? strength.targetElo);
		slider = createSlider(part(content, ".sl-live__strength-slider"), {
			min: LIMITS.eloMin,
			max: LIMITS.eloMax,
			step: SLIDER_STEP,
			...reading,
			label: strengthLabel,
			danger: (v) => v >= UI_TIMINGS.strengthDangerElo,
			dangerHint: COPY.strength.warning,
			ariaLabel: COPY_LIVE.strength.rating,
			// The same single divider as the Settings slider (owner, 2026-09-15).
			threshold: STRENGTH_NETWORK_THRESHOLD,
			strength: true,
			onChange: (value, commit) => {
				if (commit && !strength?.matchOpponentRating) write({ strength: { targetElo: value } });
			},
		});
		popover = openPopover(open, content, {
			title: COPY_LIVE.strength.header,
			footer: COPY.strength.popoverFooter,
			onClose: () => {
				disposeContent();
				popover = null;
				syncExpanded();
			},
		});
		syncExpanded();
	}

	const onOpen = (event: MouseEvent): void => {
		event.preventDefault();
		if (handsOff) return;
		if (popover?.open) closePopover();
		else openStrength();
	};
	open.addEventListener("click", onOpen);

	function update(state: StrengthCardState): void {
		handsOff = state.handsOff;
		strength = state.snapshot.settings.strength;
		const active = state.snapshot.opponent?.derivedTargetElo ?? strength.targetElo;
		activeElo = active;
		el.classList.toggle("sl-strength--hot", active >= STRENGTH_UI.glowElo);
		elo.textContent = String(active);
		label.textContent = strengthBandLabel(active);
		el.setAttribute("aria-label", COPY.strength.card(active, strengthBandLabel(active)));
		if (handsOff) {
			open.setAttribute("aria-disabled", "true");
			closePopover();
		} else open.removeAttribute("aria-disabled");
		// The open popover follows external changes (another view, the SW's normalisation) and, while
		// matching, the Elo actually being played.
		slider?.update(sliderReading(strength, active));
	}

	return {
		el,
		get open() {
			return popover?.open === true;
		},
		update,
		dispose() {
			closePopover();
			disposeContent();
			open.removeEventListener("click", onOpen);
			el.remove();
		},
	};
}
