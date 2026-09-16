/**
 * Typed `Settings` persistence over `LOCAL_KEYS.settings`.
 * `normalizeSettings` is the single validation point: it deep-merges stored
 * data over `DEFAULT_SETTINGS`, clamps numeric ranges with `LIMITS`, replaces
 * invalid enum values with defaults and silently drops unknown keys. The keys in
 * `FORCED_SETTING_VALUES` are overwritten with the forced value on every read: patches for them
 * are still accepted (tests and the harness write them), the normaliser simply wins.
 */

import { chromeLocalGet, chromeLocalSet, onStorageChanged } from "@core/chrome/storage";
import { DEFAULT_SETTINGS, FORCED_SETTING_VALUES } from "@core/constants/defaults";
import { LIMITS, SETTINGS_RANGES } from "@core/constants/limits";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { clamp, clampInt } from "@core/util/clamp";
import type { Keybind, LogLevel, MoveQualityChipSide, Settings } from "@typedefs/settings";

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends readonly unknown[]
		? T[K]
		: T[K] extends object
			? DeepPartial<T[K]>
			: T[K];
};
export type SettingsPatch = DeepPartial<Settings>;

type Obj = Record<string, unknown>;
/** `Record<Enum, true>` forces the list to stay exhaustive against the union in `@typedefs/settings`. */
type EnumSet<E extends string> = Readonly<Record<E, true>>;

const INPUT_MODES: EnumSet<Settings["execution"]["inputMode"]> = {
	auto: true,
	drag: true,
	click: true,
};
const HIGHLIGHT_STYLES: EnumSet<Settings["automation"]["highlightStyle"]> = {
	squares: true,
	arrows: true,
	both: true,
};
const CHIP_SIDES: EnumSet<MoveQualityChipSide> = { mine: true, theirs: true, both: true };
const THEMES: EnumSet<Settings["display"]["theme"]> = { dark: true, light: true, system: true };
const REDUCED_MOTION: EnumSet<Settings["display"]["reducedMotion"]> = {
	system: true,
	on: true,
	off: true,
};
const LOG_LEVELS: EnumSet<LogLevel> = {
	silent: true,
	error: true,
	warn: true,
	info: true,
	debug: true,
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number): number =>
	typeof v === "number" && Number.isFinite(v) ? v : d;
const numIn = (v: unknown, d: number, min: number, max: number): number =>
	typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : d;
const intIn = (v: unknown, d: number, min: number, max: number): number =>
	typeof v === "number" && Number.isFinite(v) ? clampInt(v, min, max) : d;
const oneOf = <E extends string>(v: unknown, d: E, set: EnumSet<E>): E =>
	typeof v === "string" && Object.hasOwn(set, v) ? (v as E) : d;

function keybind(v: unknown, d: Keybind): Keybind {
	if (
		!isObj(v) ||
		typeof v.key !== "string" ||
		typeof v.code !== "string" ||
		typeof v.altKey !== "boolean" ||
		typeof v.ctrlKey !== "boolean" ||
		typeof v.metaKey !== "boolean" ||
		typeof v.shiftKey !== "boolean"
	)
		return { ...d };
	return {
		key: v.key,
		code: v.code,
		altKey: v.altKey,
		ctrlKey: v.ctrlKey,
		metaKey: v.metaKey,
		shiftKey: v.shiftKey,
	};
}

function threads(v: unknown, d: Settings["engine"]["threads"]): Settings["engine"]["threads"] {
	if (v === "auto") return "auto";
	if (typeof v === "number" && Number.isFinite(v))
		return clampInt(v, LIMITS.threadsMin, LIMITS.threadsMax);
	return d;
}

/** Imported ranges are finite, bounded and ordered, including profiles from earlier versions. */
function minuteRange(
	lo: unknown,
	hi: unknown,
	defaults: [number, number],
	max: number
): [number, number] {
	const first = intIn(lo, defaults[0], LIMITS.autoQueueMinutesMin, max);
	const second = intIn(hi, defaults[1], LIMITS.autoQueueMinutesMin, max);
	return first <= second ? [first, second] : [second, first];
}

/**
 * Settings layout, 2026-09-13: the `execution.previewSelects` segment ("auto" | "off") folded
 * into the rate slider, whose 0 is Off. A profile stored before that maps `"off"` to 0 and keeps
 * the stored rate otherwise; the old key itself never comes back.
 */
function previewSelectScale(execution: Obj, d: number): number {
	if (execution.previewSelects === "off") return LIMITS.previewSelectScaleMin;
	return numIn(
		execution.previewSelectScale,
		d,
		LIMITS.previewSelectScaleMin,
		LIMITS.previewSelectScaleMax
	);
}

/**
 * Base speed, 2026-09-15: `timing.speedScale` (higher = *slower*, it multiplied a duration)
 * became `timing.baseSpeed` (higher = faster) when the owner pointed out the knob was backwards.
 * There is no schema version field, so the migration is inferred from the stored object itself: a
 * finite `baseSpeed` wins; failing that a finite, positive `speedScale` becomes its reciprocal,
 * clamped to the new range and **rounded to 2 decimals** — so the old 1.3 imports as 0.77 and the
 * old 0.5 as 2. Pace is preserved to within the rounding (at most 0.5 %); 2 decimals rather than
 * the slider's 0.05 step because a reciprocal is rarely on that grid and halving the error costs
 * nothing — the panel snaps the value to a tick on the next drag. Neither key present (or a
 * garbage one) reads the default.
 */
function baseSpeed(timing: Obj, d: number): number {
	const { min, max } = SETTINGS_RANGES.baseSpeed;
	if (typeof timing.baseSpeed === "number" && Number.isFinite(timing.baseSpeed))
		return clamp(timing.baseSpeed, min, max);
	const legacy = timing.speedScale;
	if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0)
		return Math.round(clamp(1 / legacy, min, max) * 100) / 100;
	return d;
}

/**
 * Validate an arbitrary value into a complete, fresh (unfrozen) `Settings`.
 *
 * Shapes from earlier builds still load: `automation.autoQueueDelay*` (per-game delays, dropped
 * 2026-09-11), `execution.style` (dropped 2026-09-10), `execution.previewSelects` (folded into
 * the rate, above), `display.pvCount` (merged into `engine.multiPv`, 2026-09-13 — the stored
 * engine breadth wins, the display count is dropped), `timing.speedScale` (inverted into
 * `timing.baseSpeed`, above), `timing.respectBudget` and `keybinds.global` (forced since
 * 2026-09-13). Unknown keys never survive a read.
 */
export function normalizeSettings(raw: unknown): Settings {
	const D = DEFAULT_SETTINGS;
	const F = FORCED_SETTING_VALUES;
	const r: Obj = isObj(raw) ? raw : {};
	const sec = (name: keyof Settings): Obj => (isObj(r[name]) ? (r[name] as Obj) : {});
	const strength = sec("strength");
	const timing = sec("timing");
	const execution = sec("execution");
	const automation = sec("automation");
	const keybinds = sec("keybinds");
	const display = sec("display");
	const engine = sec("engine");
	const advanced = sec("advanced");
	const [autoQueueSessionMinMinutes, autoQueueSessionMaxMinutes] = minuteRange(
		automation.autoQueueSessionMinMinutes,
		automation.autoQueueSessionMaxMinutes,
		[D.automation.autoQueueSessionMinMinutes, D.automation.autoQueueSessionMaxMinutes],
		LIMITS.autoQueueSessionMinutesMax
	);
	const [autoQueueBreakMinMinutes, autoQueueBreakMaxMinutes] = minuteRange(
		automation.autoQueueBreakMinMinutes,
		automation.autoQueueBreakMaxMinutes,
		[D.automation.autoQueueBreakMinMinutes, D.automation.autoQueueBreakMaxMinutes],
		LIMITS.autoQueueBreakMinutesMax
	);
	return {
		enabled: bool(r.enabled, D.enabled),
		strength: {
			targetElo: numIn(strength.targetElo, D.strength.targetElo, LIMITS.eloMin, LIMITS.eloMax),
			matchOpponentRating: bool(strength.matchOpponentRating, D.strength.matchOpponentRating),
			personaEloOffset: num(strength.personaEloOffset, D.strength.personaEloOffset),
			persona: F.strength.persona,
			selectionMode: F.strength.selectionMode,
			useOpeningBook: bool(strength.useOpeningBook, D.strength.useOpeningBook),
			// Retire the hidden second rating offset, including values from older installs.
			blunderScale: D.strength.blunderScale,
		},
		timing: {
			// 2026-09-15: `timing.profile` (the timing presets) was removed. The normaliser rebuilds
			// this object leaf by leaf, so a `profile` left in storage by an older build is simply
			// never read and never written back.
			baseSpeed: baseSpeed(timing, D.timing.baseSpeed),
			varianceScale: num(timing.varianceScale, D.timing.varianceScale),
			premoveTendency: num(timing.premoveTendency, D.timing.premoveTendency),
			longThinkFrequency: num(timing.longThinkFrequency, D.timing.longThinkFrequency),
			respectBudget: F.timing.respectBudget,
		},
		execution: {
			motorSpeed: num(execution.motorSpeed, D.execution.motorSpeed),
			keepDebuggerAttached: F.execution.keepDebuggerAttached,
			verifyMoves: bool(execution.verifyMoves, D.execution.verifyMoves),
			calibrateFromMyMouse: F.execution.calibrateFromMyMouse,
			backend: F.execution.backend,
			inputMode: oneOf(execution.inputMode, D.execution.inputMode, INPUT_MODES),
			previewSelectScale: previewSelectScale(execution, D.execution.previewSelectScale),
		},
		automation: {
			autoMove: bool(automation.autoMove, D.automation.autoMove),
			resignLostGames: bool(automation.resignLostGames, D.automation.resignLostGames),
			autoQueue: bool(automation.autoQueue, D.automation.autoQueue),
			autoQueueSessionMinMinutes,
			autoQueueSessionMaxMinutes,
			autoQueueBreakMinMinutes,
			autoQueueBreakMaxMinutes,
			rematchTitled: bool(automation.rematchTitled, D.automation.rematchTitled),
			highlightMoves: bool(automation.highlightMoves, D.automation.highlightMoves),
			highlightStyle: oneOf(automation.highlightStyle, D.automation.highlightStyle, HIGHLIGHT_STYLES),
			boardEffects: bool(automation.boardEffects, D.automation.boardEffects),
			moveQualityChips: bool(automation.moveQualityChips, D.automation.moveQualityChips),
			// Settings stored before the picker have no such key and read as the default, `both`.
			moveQualityChipsFor: oneOf(
				automation.moveQualityChipsFor,
				D.automation.moveQualityChipsFor,
				CHIP_SIDES
			),
			moveRatingSounds: bool(automation.moveRatingSounds, D.automation.moveRatingSounds),
			forcedMateSounds: bool(automation.forcedMateSounds, D.automation.forcedMateSounds),
		},
		keybinds: {
			playMove: keybind(keybinds.playMove, D.keybinds.playMove),
			toggleAutoMove: keybind(keybinds.toggleAutoMove, D.keybinds.toggleAutoMove),
			disable: keybind(keybinds.disable, D.keybinds.disable),
			speakMove: keybind(keybinds.speakMove, D.keybinds.speakMove),
			global: F.keybinds.global,
		},
		display: {
			evalBar: bool(display.evalBar, D.display.evalBar),
			uiSounds: bool(display.uiSounds, D.display.uiSounds),
			tts: bool(display.tts, D.display.tts),
			ttsVoice: typeof display.ttsVoice === "string" ? display.ttsVoice : D.display.ttsVoice,
			theme: oneOf(display.theme, D.display.theme, THEMES),
			reducedMotion: oneOf(display.reducedMotion, D.display.reducedMotion, REDUCED_MOTION),
			virtualCursor: bool(display.virtualCursor, D.display.virtualCursor),
			cursorEffects: bool(display.cursorEffects, D.display.cursorEffects),
		},
		engine: {
			threads: threads(engine.threads, D.engine.threads),
			hashMb: intIn(engine.hashMb, D.engine.hashMb, LIMITS.hashMbMin, LIMITS.hashMbMax),
			depthCap: intIn(engine.depthCap, D.engine.depthCap, LIMITS.depthMin, LIMITS.depthMax),
			multiPv: intIn(engine.multiPv, D.engine.multiPv, LIMITS.multiPvMin, LIMITS.multiPvMax),
			nnue: F.engine.nnue,
		},
		advanced: {
			logLevel: oneOf(advanced.logLevel, D.advanced.logLevel, LOG_LEVELS),
			timingLogEnabled: bool(advanced.timingLogEnabled, D.advanced.timingLogEnabled),
		},
	};
}

/** Recursive merge of plain objects; `patch` wins, arrays and primitives replace. */
function deepMerge(base: Obj, patch: Obj): Obj {
	const out: Obj = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		const b = out[k];
		out[k] = isObj(v) && isObj(b) ? deepMerge(b, v) : v;
	}
	return out;
}

export async function getSettings(): Promise<Settings> {
	return normalizeSettings(await chromeLocalGet(LOCAL_KEYS.settings));
}

/**
 * Read-merge-write; resolves with the normalised result that was stored.
 * Not serialised: concurrent callers can lose a patch — the owner (Task 9) must queue writes.
 */
export async function setSettings(patch: SettingsPatch): Promise<Settings> {
	const current = await getSettings();
	const next = normalizeSettings(deepMerge(current as unknown as Obj, patch as Obj));
	await chromeLocalSet(LOCAL_KEYS.settings, next);
	return next;
}

/** Fires with the normalised settings whenever `LOCAL_KEYS.settings` changes; returns the unsubscribe. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
	return onStorageChanged("local", (changes) => {
		const change = changes[LOCAL_KEYS.settings];
		if (change) cb(normalizeSettings(change.newValue));
	});
}
