/** A slider row: optional named presets above it with an exact fine-tune slider beneath. */

import type { Settings } from "@typedefs/settings";
import { createSlider } from "../../components/slider";
import { SETTINGS_COPY } from "../../copy";
import { instantiate, part } from "../../template";
import presetsHtml from "../templates/settings/presets.html?raw";
import { createChoices } from "./choices";
import type { RowControl, RowHost, RowShell } from "./row-control";
import {
	clampRowValue,
	fromDisplayValue,
	getAtPath,
	patchAtPath,
	type RowSpec,
	toDisplayValue,
} from "./rows";

export function buildSlider(
	spec: Extract<RowSpec, { kind: "slider" }>,
	row: RowShell,
	host: RowHost
): RowControl {
	const value = (): unknown => getAtPath(host.settings(), spec.path);
	row.el.classList.add("sl-settings-row--stack");
	const presets = spec.presets ? instantiate(presetsHtml) : null;
	if (presets) row.control.append(presets);
	const choices =
		spec.presets && presets
			? createChoices(part(presets, ".sl-settings-presets__choices"), {
					label: spec.label,
					items: spec.presets,
					value: String(value()),
					onChange: (id) => host.write(patchAtPath(spec.path, Number(id))),
				})
			: null;
	const summary = presets ? part(presets, ".sl-settings-presets__summary") : null;
	/** The stored leaf in the slider's own (display) unit, snapped to the row's range. */
	const shown = (s: Settings): number =>
		clampRowValue(spec.path, toDisplayValue(spec.path, Number(getAtPath(s, spec.path))));
	/**
	 * While opponent matching is on, the target rating shows the Elo actually being played
	 * (owner, 2026-09-15: "make the slider automatically adjust to whatever the current played
	 * elo is"): the session's derived target — opponent rating plus persona offset — or, before
	 * a rating is known, the stored target the session plays at meanwhile (`host.activeElo`).
	 * It is a reading, shown unsnapped: the row stays disabled and nothing is written from it.
	 */
	const reading = (s: Settings): { value: number; exact: boolean } =>
		spec.path === "strength.targetElo" && s.strength.matchOpponentRating
			? { value: host.activeElo(), exact: true }
			: spec.presets
				? { value: Number(getAtPath(s, spec.path)), exact: true }
				: { value: shown(s), exact: false };
	const initial = reading(host.settings());
	const slider = createSlider(
		presets ? part(presets, ".sl-settings-presets__slider") : row.control,
		{
			min: spec.min,
			max: spec.max,
			step: spec.step,
			value: initial.value,
			exact: initial.exact,
			label: spec.valueLabel,
			format: spec.format,
			ariaLabel: spec.label,
			strength: spec.path === "strength.targetElo",
			...(spec.readout ? { readout: spec.readout } : {}),
			...(spec.caption ? { caption: spec.caption } : {}),
			...(spec.threshold ? { threshold: spec.threshold } : {}),
			...(spec.markers ? { markers: spec.markers } : {}),
			...(spec.danger ? { danger: spec.danger } : {}),
			...(spec.dangerHint ? { dangerHint: spec.dangerHint } : {}),
			onChange: (v, commit) => {
				if (commit)
					host.write(patchAtPath(spec.path, fromDisplayValue(spec.path, clampRowValue(spec.path, v))));
			},
		}
	);
	const render = (s: Settings): void => {
		const current = reading(s);
		slider.update(current);
		choices?.update({ value: String(getAtPath(s, spec.path)) });
		if (summary)
			summary.textContent = SETTINGS_COPY.fineTune(
				(spec.readout ?? spec.format)(current.value),
				!spec.presets?.some((p) => Number(p.id) === Number(getAtPath(s, spec.path)))
			);
	};
	render(host.settings());
	return {
		el: row.el,
		setValue: render,
		setDisabled: (d) => {
			slider.update({ disabled: d });
			choices?.update({ disabled: d });
		},
		dispose: () => {
			slider.dispose();
			choices?.dispose();
		},
	};
}
