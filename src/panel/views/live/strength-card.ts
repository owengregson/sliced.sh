/**
 * Strength card (Appendix F §4.4 item 7, §5.12): one row — big Elo in `numeral-sm`, band label
 * + persona in `body`, a chevron that opens a popover anchored to the card with the 400–3200
 * slider, the four persona chips and the selection-mode segment. Changes apply immediately
 * through `setSettings`; the footer says "Applies from next move". The card itself follows
 * the snapshot (never the popover's local value), so the SW's normalised settings win.
 */

import { LIMITS } from "@core/constants/limits";
import type { PanelSnapshot } from "@core/constants/messages";
import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import { log } from "@core/logger";
import { type SettingsPatch, setSettings } from "@core/storage/settings-storage";
import type { PersonaId, Settings } from "@typedefs/settings";
import { type ChipGroupHandle, createChipGroup } from "../../components/chip";
import { openPopover, type PopoverHandle } from "../../components/popover";
import { createSegment, type SegmentHandle } from "../../components/segment";
import { createSlider, type SliderHandle } from "../../components/slider";
import { COPY, COPY_LIVE } from "../../copy";
import { mountIcons } from "../../icons-mount";
import { instantiate, part } from "../../template";
import cardHtml from "../templates/live/strength-card.html?raw";
import popoverHtml from "../templates/live/strength-popover.html?raw";

type SelectionMode = Settings["strength"]["selectionMode"];
type BandId = keyof typeof COPY.strength.bands;

/** Appendix F §7.2 "Strength labels" (`STRENGTH_UI.bandFloors`), typed against the copy keys. */
const BAND_FLOORS: ReadonlyArray<readonly [number, BandId]> = STRENGTH_UI.bandFloors;
const SLIDER_STEP = STRENGTH_UI.sliderStep;
const PERSONAS: readonly PersonaId[] = ["cautious", "balanced", "aggressive", "blitz"];
const MODES: readonly SelectionMode[] = ["engine-elo", "persona-sampling", "hybrid"];

export function strengthBand(elo: number): BandId {
	for (const [floor, band] of BAND_FLOORS) if (elo >= floor) return band;
	return "casual";
}

export function bandLabel(elo: number): string {
	return COPY.strength.bands[strengthBand(elo)];
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
	let handsOff = false;
	let popover: PopoverHandle | null = null;
	let slider: SliderHandle | null = null;
	let chips: ChipGroupHandle<PersonaId> | null = null;
	let segment: SegmentHandle<SelectionMode> | null = null;

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
		chips?.dispose();
		segment?.dispose();
		slider = null;
		chips = null;
		segment = null;
	}

	function openStrength(): void {
		if (!strength) return;
		const content = instantiate(popoverHtml);
		slider = createSlider(part(content, ".sl-live__strength-slider"), {
			min: LIMITS.eloMin,
			max: LIMITS.eloMax,
			step: SLIDER_STEP,
			value: strength.targetElo,
			label: (v) => `${bandLabel(v)} ${v}`,
			danger: (v) => v >= UI_TIMINGS.strengthDangerElo,
			dangerHint: COPY.strength.warning,
			ariaLabel: COPY_LIVE.strength.rating,
			onChange: (value, commit) => {
				if (commit) write({ strength: { targetElo: value } });
			},
		});
		chips = createChipGroup<PersonaId>(part(content, ".sl-live__strength-personas"), {
			items: PERSONAS.map((id) => ({
				id,
				label: COPY.personaName[id],
				icon: `persona.${id}` as const,
			})),
			value: strength.persona,
			onChange: (value) => {
				if (value) write({ strength: { persona: value } });
			},
		});
		part(content, ".sl-live__strength-mode-label").textContent = COPY_LIVE.strength.modeLabel;
		segment = createSegment<SelectionMode>(part(content, ".sl-live__strength-mode-segment"), {
			items: MODES.map((id) => ({ id, label: COPY_LIVE.strength.modes[id] })),
			value: strength.selectionMode,
			ariaLabel: COPY_LIVE.strength.modeLabel,
			onChange: (value) => write({ strength: { selectionMode: value } }),
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
		elo.textContent = String(strength.targetElo);
		label.textContent = `${bandLabel(strength.targetElo)} · ${COPY.personaName[strength.persona]}`;
		el.setAttribute(
			"aria-label",
			COPY.strength.card(
				strength.targetElo,
				bandLabel(strength.targetElo),
				COPY.personaName[strength.persona]
			)
		);
		if (handsOff) {
			open.setAttribute("aria-disabled", "true");
			closePopover();
		} else open.removeAttribute("aria-disabled");
		// The open popover follows external changes (another view, the SW's normalisation).
		slider?.update({ value: strength.targetElo });
		chips?.update({ value: strength.persona });
		segment?.update({ value: strength.selectionMode });
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
