/**
 * Chip group (Appendix F §5.15): `control.sm` pills, `surface-sunken` at rest, `brand-tint` +
 * `brand-text` when selected with a check icon in single-select groups. `aria-pressed` per chip.
 */

import type { IconName } from "@design/icons";
import { applyIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/chip.html?raw";

export interface ChipItem<T extends string> {
	id: T;
	label: string;
	icon?: IconName;
	disabled?: boolean;
}

export interface ChipGroupOptions<T extends string> {
	items: ReadonlyArray<ChipItem<T>>;
	value: T | null;
	/** Single-select shows the check icon (default); `multi` toggles independently. */
	multi?: boolean;
	values?: ReadonlyArray<T>;
	onChange: (value: T | null, values: T[]) => void;
}

export interface ChipGroupHandle<T extends string> {
	readonly el: HTMLElement;
	readonly value: T | null;
	readonly values: T[];
	update(patch: { value?: T | null; values?: ReadonlyArray<T>; disabled?: boolean }): void;
	dispose(): void;
}

export function createChipGroup<T extends string>(
	host: HTMLElement | null,
	options: ChipGroupOptions<T>
): ChipGroupHandle<T> {
	const el = document.createElement("div");
	el.className = "sl-chip-group sl-row sl-row--wrap";
	el.setAttribute("role", "group");
	const multi = options.multi === true;
	let selected = new Set<T>(multi ? (options.values ?? []) : options.value ? [options.value] : []);
	let disabled = false;
	const chips = new Map<T, HTMLButtonElement>();

	for (const item of options.items) {
		const chip = instantiate<HTMLButtonElement>(html);
		chip.dataset.value = item.id;
		part(chip, ".sl-chip__label").textContent = item.label;
		if (item.icon) {
			const icon = part(chip, ".sl-chip__icon");
			applyIcon(icon, item.icon);
			icon.hidden = false;
		}
		if (item.disabled) chip.setAttribute("aria-disabled", "true");
		el.append(chip);
		chips.set(item.id, chip);
	}

	function render(): void {
		for (const [id, chip] of chips) {
			const on = selected.has(id);
			chip.setAttribute("aria-pressed", on ? "true" : "false");
			chip.classList.toggle("is-selected", on);
			part(chip, ".sl-chip__check").hidden = !(on && !multi);
		}
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
	}

	const value = (): T | null => [...selected][0] ?? null;

	const onClick = (event: MouseEvent): void => {
		const chip = (event.target as Element | null)?.closest<HTMLButtonElement>(".sl-chip");
		if (!chip || !el.contains(chip) || disabled) return;
		event.preventDefault();
		if (chip.getAttribute("aria-disabled") === "true") return;
		const id = chip.dataset.value as T;
		if (multi) {
			if (selected.has(id)) selected.delete(id);
			else selected.add(id);
		} else {
			if (selected.has(id)) return;
			selected = new Set([id]);
		}
		render();
		options.onChange(value(), [...selected]);
	};
	el.addEventListener("click", onClick);
	render();
	host?.append(el);

	return {
		el,
		get value() {
			return value();
		},
		get values() {
			return [...selected];
		},
		update(patch) {
			if (patch.disabled !== undefined) disabled = patch.disabled;
			if (patch.values !== undefined) selected = new Set(patch.values);
			else if (patch.value !== undefined) selected = new Set(patch.value ? [patch.value] : []);
			render();
		},
		dispose() {
			el.removeEventListener("click", onClick);
			el.remove();
		},
	};
}
