/**
 * Settings rows as a typed declarative table (Task 25). Every leaf of `Settings` (Part I §4.4)
 * maps to exactly one row — a control kind, its copy (looked up by path in `SETTINGS_COPY`) and
 * the clamp range from `LIMITS` / `SETTINGS_RANGES` — except the leaves the extension decides
 * (`FORCED_SETTINGS` and `MANAGED_SETTINGS` in `sections.ts`). `test/panel/views/settings.test.ts` walks
 * `DEFAULT_SETTINGS` and fails when any other leaf has no row here.
 */

import { LIMITS, SETTINGS_RANGES } from "@core/constants/limits";
import { UI_TIMINGS } from "@core/constants/ui";
import { clamp, clampInt } from "@core/util/clamp";
import type { Keybind, Keybinds, Settings } from "@typedefs/settings";
import type { SliderThreshold } from "../../components/slider";
import {
	STRENGTH_NETWORK_THRESHOLD,
	strengthBandLabel,
	strengthLabel,
} from "../../components/strength-threshold";
import { COPY, SETTINGS_COPY } from "../../copy";
import type { ChoiceItem } from "./choices";

/** The band lookup is shared with the Live strength card; re-exported for the Settings table's users. */
export { strengthBand, strengthLabel } from "../../components/strength-threshold";

// ── paths ───────────────────────────────────────────────────────────────────────────────────

export type LeafPaths<T, P extends string = ""> = {
	[K in keyof T & string]: NonNullable<T[K]> extends Keybind
		? `${P}${K}`
		: NonNullable<T[K]> extends object
			? LeafPaths<T[K], `${P}${K}.`>
			: `${P}${K}`;
}[keyof T & string];

/** Dotted path to a `Settings` leaf; a `Keybind` counts as one leaf. */
export type SettingsLeafPath = LeafPaths<Settings>;

export type KeybindAction = keyof Omit<Keybinds, "global">;

// ── row kinds ───────────────────────────────────────────────────────────────────────────────

interface RowBase {
	path: SettingsLeafPath;
	label: string;
	help?: string;
}

export interface ToggleRow extends RowBase {
	kind: "toggle";
}

/**
 * Optional display conversion. Range and formatters use the display unit.
 */
export interface SliderDisplayMap {
	toDisplay: (stored: number) => number;
	fromDisplay: (display: number) => number;
}

export interface SliderRow extends RowBase {
	kind: "slider";
	presets?: readonly ChoiceItem[];
	min: number;
	max: number;
	step: number;
	/** Human label for the bubble / `aria-valuetext`. */
	valueLabel: (value: number) => string;
	/** Resting text on the right — a number, or a label ("Natural") when `readout` is set. */
	format: (value: number) => string;
	/**
	 * The numeric readout under the thumb while the slider is changing, for rows whose resting
	 * text is a label (settings layout, 2026-09-13).
	 */
	readout?: (value: number) => string;
	display?: SliderDisplayMap;
	/** The current value's category under the track (`SliderOptions.caption`). */
	caption?: (value: number) => string;
	threshold?: SliderThreshold;
	/** Unlabelled hairline markers on the track (the offset sliders' even point). */
	markers?: readonly number[];
	danger?: (value: number) => boolean;
	dangerHint?: string;
}

export interface OptionItem {
	id: string;
	label: string;
}

export interface ChoiceRow extends RowBase {
	kind: "choices";
	items: readonly ChoiceItem[];
}

export interface ChipsRow extends RowBase {
	kind: "chips";
	items: readonly OptionItem[];
}

export interface SegmentRow extends RowBase {
	kind: "segment";
	items: readonly OptionItem[];
	/** Boolean settings rendered as a two-way segment: `[falseId, trueId]`. */
	boolean?: readonly [string, string];
}

export interface StepperRow extends RowBase {
	kind: "stepper";
	min: number;
	max: number;
	format?: (value: number) => string;
	/** `engine.threads`: the position below `min` is the `"auto"` sentinel. */
	auto?: boolean;
}

export interface SelectRow extends RowBase {
	kind: "select";
	options: readonly OptionItem[] | "voices";
}

export interface KeybindRow extends RowBase {
	kind: "keybind";
	action: KeybindAction;
}

export interface AutomaticDepthRow extends RowBase {
	kind: "automatic-depth";
}

export type RowSpec =
	| ToggleRow
	| SliderRow
	| ChoiceRow
	| ChipsRow
	| SegmentRow
	| StepperRow
	| SelectRow
	| KeybindRow
	| AutomaticDepthRow;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

/** A leaf that has row copy — the forced leaves (`FORCED_SETTINGS`) deliberately have none. */
type CopiedPath = SettingsLeafPath & keyof typeof SETTINGS_COPY.rows;

const rowCopy = (path: CopiedPath): { label: string; help?: string } => SETTINGS_COPY.rows[path];

function items<T extends string>(labels: Readonly<Record<T, string>>): OptionItem[] {
	return (Object.keys(labels) as T[]).map((id) => ({ id, label: labels[id] }));
}

const VARIANCE_LOW_MAX = 0.67;
const VARIANCE_MEDIUM_MAX = 1.34;
function varianceLabel(scale: number): string {
	if (scale < VARIANCE_LOW_MAX) return SETTINGS_COPY.format.variance.low;
	if (scale < VARIANCE_MEDIUM_MAX) return SETTINGS_COPY.format.variance.medium;
	return SETTINGS_COPY.format.variance.high;
}

const MOTOR_SLOW_MAX = 0.85;
const MOTOR_NATURAL_MAX = 1.15;
function motorLabel(scale: number): string {
	if (scale < MOTOR_SLOW_MAX) return SETTINGS_COPY.format.motor.slow;
	if (scale <= MOTOR_NATURAL_MAX) return SETTINGS_COPY.format.motor.natural;
	return SETTINGS_COPY.format.motor.fast;
}

/** The preview-selection slider: its 0 is Off, everything above is a rate. */
function previewLabel(scale: number): string {
	return scale <= LIMITS.previewSelectScaleMin
		? SETTINGS_COPY.format.previewOff
		: SETTINGS_COPY.format.times(scale);
}

/** Power-of-two hash sizes inside `LIMITS.hashMbMin..hashMbMax`. */
function hashSizes(): OptionItem[] {
	const out: OptionItem[] = [];
	for (let mb = LIMITS.hashMbMin; mb <= LIMITS.hashMbMax; mb *= 2)
		out.push({ id: String(mb), label: SETTINGS_COPY.format.mb(mb) });
	return out;
}

// 2026-09-15: the panel's own time-control class (`tcClass`, `formatTimeControl`, the
// `PROFILE_FOR_TC_CLASS` re-export) existed only so the timing-preset chips could pre-select and
// label the detected preset. The presets were removed at the owner's request and nothing else in
// the panel reads the time control, so the block went with them.

// ── the table ───────────────────────────────────────────────────────────────────────────────

const toggle = (path: CopiedPath): ToggleRow => ({ kind: "toggle", path, ...rowCopy(path) });

const keybind = (path: CopiedPath, action: KeybindAction): KeybindRow => ({
	kind: "keybind",
	path,
	action,
	...rowCopy(path),
});

export const ROWS: readonly RowSpec[] = [
	// strength
	{
		kind: "slider",
		path: "strength.targetElo",
		...rowCopy("strength.targetElo"),
		min: LIMITS.eloMin,
		max: LIMITS.eloMax,
		step: 50,
		valueLabel: strengthLabel,
		format: String,
		// Owner, 2026-09-15: the current category under the slider instead of every category, and
		// one divider — the Maia cutoff, where the full network takes over — with no second marker.
		caption: strengthBandLabel,
		threshold: STRENGTH_NETWORK_THRESHOLD,
		danger: (v) => v >= UI_TIMINGS.strengthDangerElo,
		dangerHint: COPY.strength.warning,
	},
	toggle("strength.matchOpponentRating"),
	{
		kind: "slider",
		path: "strength.personaEloOffset",
		...rowCopy("strength.personaEloOffset"),
		...SETTINGS_RANGES.personaEloOffset,
		valueLabel: SETTINGS_COPY.format.offset,
		format: SETTINGS_COPY.format.offset,
		// The even point (owner, 2026-09-12): an unlabelled hairline at ±0.
		markers: [0],
	},
	toggle("strength.useOpeningBook"),
	// automation
	toggle("enabled"),
	toggle("automation.resignLostGames"),
	toggle("automation.autoQueue"),
	{
		kind: "stepper",
		path: "automation.autoQueueSessionMinMinutes",
		...rowCopy("automation.autoQueueSessionMinMinutes"),
		min: LIMITS.autoQueueMinutesMin,
		max: LIMITS.autoQueueSessionMinutesMax,
		format: SETTINGS_COPY.format.minutes,
	},
	{
		kind: "stepper",
		path: "automation.autoQueueSessionMaxMinutes",
		...rowCopy("automation.autoQueueSessionMaxMinutes"),
		min: LIMITS.autoQueueMinutesMin,
		max: LIMITS.autoQueueSessionMinutesMax,
		format: SETTINGS_COPY.format.minutes,
	},
	{
		kind: "stepper",
		path: "automation.autoQueueBreakMinMinutes",
		...rowCopy("automation.autoQueueBreakMinMinutes"),
		min: LIMITS.autoQueueMinutesMin,
		max: LIMITS.autoQueueBreakMinutesMax,
		format: SETTINGS_COPY.format.minutes,
	},
	{
		kind: "stepper",
		path: "automation.autoQueueBreakMaxMinutes",
		...rowCopy("automation.autoQueueBreakMaxMinutes"),
		min: LIMITS.autoQueueMinutesMin,
		max: LIMITS.autoQueueBreakMinutesMax,
		format: SETTINGS_COPY.format.minutes,
	},
	toggle("automation.rematchTitled"),
	// timing
	{
		kind: "slider",
		path: "timing.baseSpeed",
		presets: SETTINGS_COPY.choices.pace,
		...rowCopy("timing.baseSpeed"),
		...SETTINGS_RANGES.baseSpeed,
		valueLabel: SETTINGS_COPY.format.times,
		format: SETTINGS_COPY.format.times,
	},
	{
		kind: "slider",
		path: "timing.varianceScale",
		presets: SETTINGS_COPY.choices.variety,
		...rowCopy("timing.varianceScale"),
		...SETTINGS_RANGES.varianceScale,
		valueLabel: varianceLabel,
		format: varianceLabel,
		readout: SETTINGS_COPY.format.times,
	},
	{
		kind: "slider",
		path: "timing.longThinkFrequency",
		presets: SETTINGS_COPY.choices.longThink,
		...rowCopy("timing.longThinkFrequency"),
		...SETTINGS_RANGES.longThinkFrequency,
		valueLabel: SETTINGS_COPY.format.times,
		format: SETTINGS_COPY.format.times,
	},
	{
		kind: "slider",
		path: "timing.premoveTendency",
		presets: SETTINGS_COPY.choices.premove,
		...rowCopy("timing.premoveTendency"),
		...SETTINGS_RANGES.premoveTendency,
		valueLabel: SETTINGS_COPY.format.percent,
		format: SETTINGS_COPY.format.percent,
	},
	// hand
	{
		kind: "choices",
		path: "execution.inputMode",
		...rowCopy("execution.inputMode"),
		items: SETTINGS_COPY.choices.input,
	},
	{
		kind: "slider",
		path: "execution.motorSpeed",
		presets: SETTINGS_COPY.choices.motor,
		...rowCopy("execution.motorSpeed"),
		...SETTINGS_RANGES.motorSpeed,
		valueLabel: motorLabel,
		format: motorLabel,
		readout: SETTINGS_COPY.format.times,
	},
	{
		kind: "slider",
		path: "execution.previewSelectScale",
		presets: SETTINGS_COPY.choices.preview,
		...rowCopy("execution.previewSelectScale"),
		...SETTINGS_RANGES.previewSelectScale,
		valueLabel: previewLabel,
		format: previewLabel,
	},
	{
		kind: "toggle",
		path: "execution.verifyMoves",
		label: rowCopy("execution.verifyMoves").label,
		help: COPY.execution.verify,
	},
	// board
	toggle("automation.highlightMoves"),
	{
		kind: "chips",
		path: "automation.highlightStyle",
		...rowCopy("automation.highlightStyle"),
		items: items(SETTINGS_COPY.options.highlightStyle),
	},
	toggle("automation.boardEffects"),
	toggle("automation.freeTitle"),
	{
		kind: "segment",
		path: "automation.freeTitleBadge",
		...rowCopy("automation.freeTitleBadge"),
		items: items(SETTINGS_COPY.options.freeTitleBadge),
	},
	toggle("automation.moveQualityChips"),
	{
		kind: "segment",
		path: "automation.moveQualityChipsFor",
		...rowCopy("automation.moveQualityChipsFor"),
		items: items(SETTINGS_COPY.options.moveQualityChipsFor),
	},
	toggle("automation.moveRatingSounds"),
	toggle("automation.forcedMateSounds"),
	toggle("display.virtualCursor"),
	toggle("display.cursorEffects"),
	// panel
	toggle("display.evalBar"),
	{
		kind: "stepper",
		path: "engine.multiPv",
		...rowCopy("engine.multiPv"),
		min: LIMITS.multiPvMin,
		max: LIMITS.multiPvMax,
	},
	{
		kind: "choices",
		path: "display.theme",
		...rowCopy("display.theme"),
		items: items(SETTINGS_COPY.options.theme),
	},
	{
		kind: "choices",
		path: "display.reducedMotion",
		...rowCopy("display.reducedMotion"),
		items: items(SETTINGS_COPY.options.reducedMotion),
	},
	toggle("display.uiSounds"),
	{ kind: "select", path: "display.ttsVoice", ...rowCopy("display.ttsVoice"), options: "voices" },
	// keybinds
	keybind("keybinds.playMove", "playMove"),
	keybind("keybinds.toggleAutoMove", "toggleAutoMove"),
	keybind("keybinds.disable", "disable"),
	keybind("keybinds.speakMove", "speakMove"),
	// engine
	{
		kind: "stepper",
		path: "engine.threads",
		...rowCopy("engine.threads"),
		min: LIMITS.threadsMin,
		max: LIMITS.threadsMax,
		auto: true,
	},
	{ kind: "select", path: "engine.hashMb", ...rowCopy("engine.hashMb"), options: hashSizes() },
	{
		kind: "automatic-depth",
		path: "engine.depthCap",
		...rowCopy("engine.depthCap"),
	},
	// advanced
	{
		kind: "select",
		path: "advanced.logLevel",
		...rowCopy("advanced.logLevel"),
		options: items(SETTINGS_COPY.options.logLevel),
	},
	toggle("advanced.timingLogEnabled"),
];

const BY_PATH: ReadonlyMap<SettingsLeafPath, RowSpec> = new Map(ROWS.map((r) => [r.path, r]));

export function rowFor(path: SettingsLeafPath): RowSpec {
	const row = BY_PATH.get(path);
	if (!row) throw new Error(`settings: no row for ${path}`);
	return row;
}

/** A slider row's stored value in its display unit (identity unless the row maps units). */
export function toDisplayValue(path: SettingsLeafPath, stored: number): number {
	const row = rowFor(path);
	return row.kind === "slider" && row.display ? row.display.toDisplay(stored) : stored;
}

/** A slider row's display value in its stored unit (identity unless the row maps units). */
export function fromDisplayValue(path: SettingsLeafPath, display: number): number {
	const row = rowFor(path);
	return row.kind === "slider" && row.display ? row.display.fromDisplay(display) : display;
}

/**
 * Clamp a numeric value to the row's display range: sliders snap to their step (in the display
 * unit), steppers are integers, numeric selects (hash sizes) snap to the nearest option.
 */
export function clampRowValue(path: SettingsLeafPath, value: number): number {
	const row = rowFor(path);
	if (row.kind === "slider") {
		const stepped = Math.round((value - row.min) / row.step) * row.step + row.min;
		const decimals = (String(row.step).split(".")[1] ?? "").length;
		return clamp(Number(stepped.toFixed(decimals)), row.min, row.max);
	}
	if (row.kind === "stepper") return clampInt(value, row.min, row.max);
	if (row.kind === "select" && row.options !== "voices") {
		const numeric = row.options.map((o) => Number(o.id)).filter((n) => Number.isFinite(n));
		if (numeric.length === 0) return value;
		return numeric.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best));
	}
	return value;
}

// ── path access ─────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

export function getAtPath(settings: Settings, path: SettingsLeafPath): unknown {
	let cur: unknown = settings;
	for (const seg of path.split(".")) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Obj)[seg];
	}
	return cur;
}

/** `{ strength: { targetElo: 1200 } }` for `"strength.targetElo"`. */
export function patchAtPath(path: SettingsLeafPath, value: unknown): Obj {
	const segs = path.split(".");
	const leaf = segs.pop() ?? path;
	const patch: Obj = { [leaf]: value };
	return segs.reduceRight<Obj>((inner, seg) => ({ [seg]: inner }), patch);
}
