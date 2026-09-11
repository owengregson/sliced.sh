/**
 * Settings rows as a typed declarative table (Task 25). Every leaf of `Settings` (Part I §4.4)
 * maps to exactly one row: a control kind, its copy (looked up by path in `SETTINGS_COPY`) and
 * the clamp range from `LIMITS` / `SETTINGS_RANGES`. `test/panel/views/settings.test.ts` walks
 * `DEFAULT_SETTINGS` and fails when a leaf has no row here.
 */

import { LIMITS, SETTINGS_RANGES } from "@core/constants/limits";
import { STRENGTH_LABEL_BANDS, type StrengthBand, UI_TIMINGS } from "@core/constants/ui";
import { clamp, clampInt } from "@core/util/clamp";
import type { TimeControl } from "@typedefs/game";
import type { Keybind, Keybinds, Settings } from "@typedefs/settings";
import type { SliderThreshold } from "../../components/slider";
import { STRENGTH_NETWORK_THRESHOLD } from "../../components/strength-threshold";
import { COPY, SETTINGS_COPY } from "../../copy";

// ── paths ───────────────────────────────────────────────────────────────────────────────────

type LeafPaths<T, P extends string = ""> = {
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

export interface SliderRow extends RowBase {
	kind: "slider";
	min: number;
	max: number;
	step: number;
	/** Human label for the bubble / `aria-valuetext`. */
	valueLabel: (value: number) => string;
	/** Resting numeric text. */
	format: (value: number) => string;
	scale?: readonly string[];
	threshold?: SliderThreshold;
	danger?: (value: number) => boolean;
	dangerHint?: string;
}

export interface OptionItem {
	id: string;
	label: string;
}

export interface ChipsRow extends RowBase {
	kind: "chips";
	items: readonly OptionItem[];
	/** Per-option description shown under the chips (personas). */
	descriptions?: Readonly<Record<string, string>>;
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

export type RowSpec =
	| ToggleRow
	| SliderRow
	| ChipsRow
	| SegmentRow
	| StepperRow
	| SelectRow
	| KeybindRow;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

const rowCopy = (path: SettingsLeafPath): { label: string; help?: string } =>
	SETTINGS_COPY.rows[path];

function items<T extends string>(labels: Readonly<Record<T, string>>): OptionItem[] {
	return (Object.keys(labels) as T[]).map((id) => ({ id, label: labels[id] }));
}

/** Strength band for a rating (Appendix F §7.2). */
export function strengthBand(elo: number): StrengthBand {
	let band: StrengthBand = STRENGTH_LABEL_BANDS[0].band;
	for (const b of STRENGTH_LABEL_BANDS) if (elo >= b.min) band = b.band;
	return band;
}

/** "Club 1200" — the slider bubble text. */
export function strengthLabel(elo: number): string {
	return `${COPY.strength.bands[strengthBand(elo)]} ${elo}`;
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

/** Power-of-two hash sizes inside `LIMITS.hashMbMin..hashMbMax`. */
function hashSizes(): OptionItem[] {
	const out: OptionItem[] = [];
	for (let mb = LIMITS.hashMbMin; mb <= LIMITS.hashMbMax; mb *= 2)
		out.push({ id: String(mb), label: SETTINGS_COPY.format.mb(mb) });
	return out;
}

// ── time control class (Task 16 lane owns the real one) ─────────────────────────────────────
// Replace with `tcClass` from `@core/timing` at integration; the thresholds are lichess's
// estimated-duration classes (base + 40 × increment, in seconds).

export type TcClass = "bullet" | "blitz" | "rapid" | "classical";
const TC_INCREMENT_WEIGHT = 40;
const TC_BULLET_MAX_S = 179;
const TC_BLITZ_MAX_S = 479;
const TC_RAPID_MAX_S = 1499;
const MS_PER_S = 1_000;
const S_PER_MIN = 60;

export function tcClass(tc: TimeControl): TcClass {
	const estimate = (tc.baseMs + TC_INCREMENT_WEIGHT * tc.incMs) / MS_PER_S;
	if (estimate <= TC_BULLET_MAX_S) return "bullet";
	if (estimate <= TC_BLITZ_MAX_S) return "blitz";
	if (estimate <= TC_RAPID_MAX_S) return "rapid";
	return "classical";
}

/**
 * The timing preset a detected time control pre-selects (Appendix F §4.6), from the registry the
 * `GameSession` applies (Task 30) — the chips show exactly what the timing model runs. The
 * chips stay display-only: only a user pick writes `timing.profile`.
 */
export { PROFILE_FOR_TC_CLASS } from "@core/constants/timings";

/** "blitz 3+2" for the "Detected: …" note. */
export function formatTimeControl(tc: TimeControl): string {
	const minutes = Math.round(tc.baseMs / MS_PER_S / S_PER_MIN);
	const inc = Math.round(tc.incMs / MS_PER_S);
	return `${SETTINGS_COPY.tc[tcClass(tc)]} ${minutes}+${inc}`;
}

// ── the table ───────────────────────────────────────────────────────────────────────────────

const toggle = (path: SettingsLeafPath): ToggleRow => ({ kind: "toggle", path, ...rowCopy(path) });

const keybind = (path: SettingsLeafPath, action: KeybindAction): KeybindRow => ({
	kind: "keybind",
	path,
	action,
	...rowCopy(path),
});

export const ROWS: readonly RowSpec[] = [
	toggle("enabled"),
	// strength
	toggle("strength.matchOpponentRating"),
	{
		kind: "slider",
		path: "strength.personaEloOffset",
		...rowCopy("strength.personaEloOffset"),
		...SETTINGS_RANGES.personaEloOffset,
		valueLabel: SETTINGS_COPY.format.offset,
		format: SETTINGS_COPY.format.offset,
	},
	{
		kind: "slider",
		path: "strength.targetElo",
		...rowCopy("strength.targetElo"),
		min: LIMITS.eloMin,
		max: LIMITS.eloMax,
		step: 50,
		valueLabel: strengthLabel,
		format: String,
		scale: STRENGTH_LABEL_BANDS.map((b) => COPY.strength.bands[b.band]),
		threshold: STRENGTH_NETWORK_THRESHOLD,
		danger: (v) => v >= UI_TIMINGS.strengthDangerElo,
		dangerHint: COPY.strength.warning,
	},
	{
		kind: "chips",
		path: "strength.persona",
		...rowCopy("strength.persona"),
		items: items(COPY.personaName),
		descriptions: COPY.persona,
	},
	{
		kind: "chips",
		path: "strength.selectionMode",
		...rowCopy("strength.selectionMode"),
		items: items(SETTINGS_COPY.options.selectionMode),
	},
	{
		kind: "slider",
		path: "strength.blunderScale",
		...rowCopy("strength.blunderScale"),
		min: LIMITS.blunderScaleMin,
		max: LIMITS.blunderScaleMax,
		step: 0.05,
		valueLabel: SETTINGS_COPY.format.times,
		format: SETTINGS_COPY.format.times,
	},
	toggle("strength.useOpeningBook"),
	// timing
	{
		kind: "chips",
		path: "timing.profile",
		...rowCopy("timing.profile"),
		items: items(SETTINGS_COPY.options.profile),
		descriptions: { manual: COPY.timing.manualOnly },
	},
	{
		kind: "slider",
		path: "timing.speedScale",
		...rowCopy("timing.speedScale"),
		...SETTINGS_RANGES.speedScale,
		valueLabel: SETTINGS_COPY.format.times,
		format: SETTINGS_COPY.format.times,
	},
	{
		kind: "slider",
		path: "timing.varianceScale",
		...rowCopy("timing.varianceScale"),
		...SETTINGS_RANGES.varianceScale,
		valueLabel: varianceLabel,
		format: varianceLabel,
	},
	{
		kind: "slider",
		path: "timing.premoveTendency",
		...rowCopy("timing.premoveTendency"),
		...SETTINGS_RANGES.premoveTendency,
		valueLabel: SETTINGS_COPY.format.percent,
		format: SETTINGS_COPY.format.percent,
	},
	{
		kind: "slider",
		path: "timing.longThinkFrequency",
		...rowCopy("timing.longThinkFrequency"),
		...SETTINGS_RANGES.longThinkFrequency,
		valueLabel: SETTINGS_COPY.format.times,
		format: SETTINGS_COPY.format.times,
	},
	toggle("timing.respectBudget"),
	// execution
	toggle("automation.autoMove"),
	toggle("automation.autoQueue"),
	{
		kind: "slider",
		path: "execution.motorSpeed",
		...rowCopy("execution.motorSpeed"),
		...SETTINGS_RANGES.motorSpeed,
		valueLabel: motorLabel,
		format: motorLabel,
	},
	toggle("execution.calibrateFromMyMouse"),
	{
		kind: "segment",
		path: "execution.previewSelects",
		...rowCopy("execution.previewSelects"),
		items: items(SETTINGS_COPY.options.previewSelects),
	},
	{
		kind: "slider",
		path: "execution.previewSelectScale",
		...rowCopy("execution.previewSelectScale"),
		min: LIMITS.previewSelectScaleMin,
		max: LIMITS.previewSelectScaleMax,
		step: 0.05,
		valueLabel: SETTINGS_COPY.format.times,
		format: SETTINGS_COPY.format.times,
	},
	{
		kind: "segment",
		path: "execution.backend",
		...rowCopy("execution.backend"),
		items: items(SETTINGS_COPY.options.backend),
	},
	{
		kind: "toggle",
		path: "execution.keepDebuggerAttached",
		label: rowCopy("execution.keepDebuggerAttached").label,
		help: COPY.execution.debugger,
	},
	{
		kind: "toggle",
		path: "execution.verifyMoves",
		label: rowCopy("execution.verifyMoves").label,
		help: COPY.execution.verify,
	},
	// keybinds
	keybind("keybinds.playMove", "playMove"),
	keybind("keybinds.toggleAutoMove", "toggleAutoMove"),
	keybind("keybinds.disable", "disable"),
	keybind("keybinds.speakMove", "speakMove"),
	{
		kind: "segment",
		path: "keybinds.global",
		label: rowCopy("keybinds.global").label,
		help: COPY.keybind.global,
		items: items(SETTINGS_COPY.options.scope),
		boolean: ["page", "global"],
	},
	// display
	toggle("automation.highlightMoves"),
	{
		kind: "chips",
		path: "automation.highlightStyle",
		...rowCopy("automation.highlightStyle"),
		items: items(SETTINGS_COPY.options.highlightStyle),
	},
	toggle("display.evalBar"),
	{
		kind: "stepper",
		path: "display.pvCount",
		...rowCopy("display.pvCount"),
		min: LIMITS.multiPvMin,
		max: LIMITS.multiPvMax,
	},
	toggle("display.uiSounds"),
	{ kind: "select", path: "display.ttsVoice", ...rowCopy("display.ttsVoice"), options: "voices" },
	{
		kind: "chips",
		path: "display.theme",
		...rowCopy("display.theme"),
		items: items(SETTINGS_COPY.options.theme),
	},
	{
		kind: "chips",
		path: "display.reducedMotion",
		...rowCopy("display.reducedMotion"),
		items: items(SETTINGS_COPY.options.reducedMotion),
	},
	toggle("display.virtualCursor"),
	// advanced
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
		kind: "slider",
		path: "engine.depthCap",
		...rowCopy("engine.depthCap"),
		min: LIMITS.depthMin,
		max: LIMITS.depthMax,
		step: 1,
		valueLabel: String,
		format: String,
	},
	{
		kind: "stepper",
		path: "engine.multiPv",
		...rowCopy("engine.multiPv"),
		min: LIMITS.multiPvMin,
		max: LIMITS.multiPvMax,
	},
	{
		kind: "chips",
		path: "engine.nnue",
		...rowCopy("engine.nnue"),
		items: items(SETTINGS_COPY.options.nnue),
	},
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

/**
 * Clamp a numeric value to the row's display range: sliders snap to their step, steppers are
 * integers, numeric selects (hash sizes) snap to the nearest option.
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
