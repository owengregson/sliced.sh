/**
 * The control a settings row renders, and the row shell around it. `buildRow` dispatches on the
 * row kind of the declarative table in `rows.ts`; every control reads and writes its leaf through
 * the `RowHost` the view provides.
 */

import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { SettingsPatch } from "@core/storage/settings-storage";
import type { Settings } from "@typedefs/settings";
import { type ChipGroupHandle, createChipGroup } from "../../components/chip";
import { createSegment } from "../../components/segment";
import { createToggle } from "../../components/toggle";
import { SETTINGS_COPY } from "../../copy";
import { instantiate, part } from "../../template";
import rowHtml from "../templates/settings/row.html?raw";
import valueHtml from "../templates/settings/value.html?raw";
import { createChoices } from "./choices";
import { createSelect, createStepper, type SelectOption } from "./controls";
import { buildKeybind } from "./row-keybind";
import { buildSlider } from "./row-slider";
import { clampRowValue, getAtPath, patchAtPath, type RowSpec, type SettingsLeafPath } from "./rows";

export interface RowControl {
	el: HTMLElement;
	setValue(settings: Settings): void;
	setDisabled(disabled: boolean): void;
	dispose(): void;
}

/** What a row needs from the view: the current settings, the active Elo, the writer, voices. */
export interface RowHost {
	settings(): Settings;
	activeElo(): number;
	write(patch: SettingsPatch): void;
	voices(): readonly SelectOption[];
}

export interface RowShell {
	el: HTMLElement;
	control: HTMLElement;
	help: HTMLElement;
}

export function newRow(spec: { path?: SettingsLeafPath; label: string; help?: string }): RowShell {
	const el = instantiate(rowHtml);
	if (spec.path) el.dataset.path = spec.path;
	part(el, ".sl-settings-row__label").textContent = spec.label;
	const help = part(el, ".sl-settings-row__help");
	if (spec.help) {
		help.textContent = spec.help;
		help.hidden = false;
	}
	return { el, control: part(el, ".sl-settings-row__control"), help };
}

export function buildRow(spec: RowSpec, host: RowHost): RowControl {
	const row = newRow(spec);
	const value = (): unknown => getAtPath(host.settings(), spec.path);
	switch (spec.kind) {
		case "automatic-depth": {
			const output = instantiate(valueHtml);
			row.control.append(output);
			const render = (): void => {
				output.textContent = SETTINGS_COPY.format.depthAuto(automaticDepthForElo(host.activeElo()));
			};
			render();
			return {
				el: row.el,
				setValue: render,
				setDisabled: () => {},
				dispose: () => output.remove(),
			};
		}
		case "toggle": {
			row.el.classList.add("sl-settings-row--toggle");
			const toggle = createToggle(row.control, {
				label: spec.label,
				checked: value() === true,
				onChange: (checked) => host.write(patchAtPath(spec.path, checked)),
			});
			return {
				el: row.el,
				setValue: (s) => toggle.update({ checked: getAtPath(s, spec.path) === true }),
				setDisabled: (d) => toggle.update({ disabled: d }),
				dispose: () => toggle.dispose(),
			};
		}
		case "slider":
			return buildSlider(spec, row, host);
		case "choices": {
			row.el.classList.add("sl-settings-row--stack");
			const choices = createChoices(row.control, {
				label: spec.label,
				items: spec.items,
				value: String(value()),
				onChange: (id) => host.write(patchAtPath(spec.path, id)),
			});
			return {
				el: row.el,
				setValue: (s) => choices.update({ value: String(getAtPath(s, spec.path)) }),
				setDisabled: (disabled) => choices.update({ disabled }),
				dispose: () => choices.dispose(),
			};
		}
		case "chips":
			return buildChips(spec, row, host);
		case "segment": {
			const toId = (v: unknown): string =>
				spec.boolean ? (v === true ? spec.boolean[1] : spec.boolean[0]) : String(v);
			const segment = createSegment<string>(row.control, {
				items: spec.items.map((i) => ({ id: i.id, label: i.label })),
				value: toId(value()),
				ariaLabel: spec.label,
				onChange: (id) =>
					host.write(patchAtPath(spec.path, spec.boolean ? id === spec.boolean[1] : id)),
			});
			return {
				el: row.el,
				setValue: (s) => segment.update({ value: toId(getAtPath(s, spec.path)) }),
				setDisabled: (d) => segment.update({ disabled: d }),
				dispose: () => segment.dispose(),
			};
		}
		case "stepper": {
			const toValue = (v: unknown): number | null =>
				spec.auto && v === "auto" ? null : clampRowValue(spec.path, Number(v));
			const stepper = createStepper(row.control, {
				min: spec.min,
				max: spec.max,
				value: toValue(value()) ?? spec.min - 1,
				ariaLabel: spec.label,
				...(spec.format ? { format: spec.format } : {}),
				...(spec.auto ? { auto: true } : {}),
				onChange: (v) => host.write(patchAtPath(spec.path, v === null ? "auto" : v)),
			});
			if (spec.auto && value() === "auto") stepper.update({ value: null });
			return {
				el: row.el,
				setValue: (s) => stepper.update({ value: toValue(getAtPath(s, spec.path)) }),
				setDisabled: (d) => stepper.update({ disabled: d }),
				dispose: () => stepper.dispose(),
			};
		}
		case "select": {
			const voices = spec.options === "voices";
			const options = (): readonly SelectOption[] =>
				voices
					? host.voices()
					: (spec.options as ReadonlyArray<{ id: string; label: string }>).map((o) => ({
							value: o.id,
							label: o.label,
						}));
			const toValue = (v: unknown): string =>
				v === null || v === undefined
					? ""
					: typeof v === "number"
						? String(clampRowValue(spec.path, v))
						: String(v);
			const select = createSelect(row.control, {
				options: options(),
				value: toValue(value()),
				ariaLabel: spec.label,
				onChange: (v) => {
					const stored = voices ? (v === "" ? null : v) : typeof value() === "number" ? Number(v) : v;
					host.write(patchAtPath(spec.path, stored));
				},
			});
			return {
				el: row.el,
				setValue: (s) => select.update({ options: options(), value: toValue(getAtPath(s, spec.path)) }),
				setDisabled: (d) => select.update({ disabled: d }),
				dispose: () => select.dispose(),
			};
		}
		case "keybind":
			return buildKeybind(spec, row, host);
	}
}

function buildChips(
	spec: Extract<RowSpec, { kind: "chips" }>,
	row: RowShell,
	host: RowHost
): RowControl {
	row.el.classList.add("sl-settings-row--stack");
	// 2026-09-15: the timing presets were the only chips row that pre-selected a value from the
	// detected time control and explained itself per option. Chips are a plain stored-value
	// control again; `newRow` renders the row's own help.
	const chips: ChipGroupHandle<string> = createChipGroup<string>(row.control, {
		items: spec.items.map((i) => ({ id: i.id, label: i.label })),
		value: String(getAtPath(host.settings(), spec.path)),
		onChange: (id) => {
			if (id === null) return;
			host.write(patchAtPath(spec.path, id));
		},
	});
	return {
		el: row.el,
		setValue: (s) => chips.update({ value: String(getAtPath(s, spec.path)) }),
		setDisabled: (d) => chips.update({ disabled: d }),
		dispose: () => chips.dispose(),
	};
}
