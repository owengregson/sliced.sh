/**
 * Typed `Settings` persistence over `LOCAL_KEYS.settings`.
 * `normalizeSettings` is the single validation point: it deep-merges stored
 * data over `DEFAULT_SETTINGS`, clamps numeric ranges with `LIMITS`, replaces
 * invalid enum values with defaults and silently drops unknown keys.
 */

import { chromeLocalGet, chromeLocalSet, onStorageChanged } from "@core/chrome/storage";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { LIMITS } from "@core/constants/limits";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { clamp, clampInt } from "@core/util/clamp";
import type { Keybind, LogLevel, PersonaId, Settings } from "@typedefs/settings";

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

const PERSONAS: EnumSet<PersonaId> = {
	cautious: true,
	balanced: true,
	aggressive: true,
	blitz: true,
};
const SELECTION_MODES: EnumSet<Settings["strength"]["selectionMode"]> = {
	"engine-elo": true,
	"persona-sampling": true,
	hybrid: true,
};
const TIMING_PROFILES: EnumSet<Settings["timing"]["profile"]> = {
	manual: true,
	fast: true,
	natural: true,
	slow: true,
	custom: true,
};
const EXEC_STYLES: EnumSet<Settings["execution"]["style"]> = {
	drag: true,
	click: true,
	auto: true,
};
const BACKENDS: EnumSet<Settings["execution"]["backend"]> = { cdp: true, native: true };
const PREVIEW_SELECTS: EnumSet<Settings["execution"]["previewSelects"]> = { auto: true, off: true };
const HIGHLIGHT_STYLES: EnumSet<Settings["automation"]["highlightStyle"]> = {
	squares: true,
	arrows: true,
	both: true,
};
const THEMES: EnumSet<Settings["display"]["theme"]> = { dark: true, light: true, system: true };
const REDUCED_MOTION: EnumSet<Settings["display"]["reducedMotion"]> = {
	system: true,
	on: true,
	off: true,
};
const NNUE: EnumSet<Settings["engine"]["nnue"]> = { small: true, big: true, auto: true };
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
	if (typeof v === "number" && Number.isFinite(v)) return clampInt(v, 1, LIMITS.threadsMax);
	return d;
}

/** Validate an arbitrary value into a complete, fresh (unfrozen) `Settings`. */
export function normalizeSettings(raw: unknown): Settings {
	const D = DEFAULT_SETTINGS;
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
	return {
		enabled: bool(r.enabled, D.enabled),
		strength: {
			targetElo: numIn(strength.targetElo, D.strength.targetElo, LIMITS.eloMin, LIMITS.eloMax),
			matchOpponentRating: bool(strength.matchOpponentRating, D.strength.matchOpponentRating),
			personaEloOffset: num(strength.personaEloOffset, D.strength.personaEloOffset),
			persona: oneOf(strength.persona, D.strength.persona, PERSONAS),
			selectionMode: oneOf(strength.selectionMode, D.strength.selectionMode, SELECTION_MODES),
			useOpeningBook: bool(strength.useOpeningBook, D.strength.useOpeningBook),
			blunderScale: numIn(
				strength.blunderScale,
				D.strength.blunderScale,
				LIMITS.blunderScaleMin,
				LIMITS.blunderScaleMax
			),
		},
		timing: {
			profile: oneOf(timing.profile, D.timing.profile, TIMING_PROFILES),
			speedScale: num(timing.speedScale, D.timing.speedScale),
			varianceScale: num(timing.varianceScale, D.timing.varianceScale),
			premoveTendency: num(timing.premoveTendency, D.timing.premoveTendency),
			longThinkFrequency: num(timing.longThinkFrequency, D.timing.longThinkFrequency),
			respectBudget: bool(timing.respectBudget, D.timing.respectBudget),
		},
		execution: {
			style: oneOf(execution.style, D.execution.style, EXEC_STYLES),
			motorSpeed: num(execution.motorSpeed, D.execution.motorSpeed),
			keepDebuggerAttached: bool(execution.keepDebuggerAttached, D.execution.keepDebuggerAttached),
			verifyMoves: bool(execution.verifyMoves, D.execution.verifyMoves),
			calibrateFromMyMouse: bool(execution.calibrateFromMyMouse, D.execution.calibrateFromMyMouse),
			backend: oneOf(execution.backend, D.execution.backend, BACKENDS),
			previewSelects: oneOf(execution.previewSelects, D.execution.previewSelects, PREVIEW_SELECTS),
			previewSelectScale: numIn(
				execution.previewSelectScale,
				D.execution.previewSelectScale,
				LIMITS.previewSelectScaleMin,
				LIMITS.previewSelectScaleMax
			),
		},
		automation: {
			autoMove: bool(automation.autoMove, D.automation.autoMove),
			autoQueue: bool(automation.autoQueue, D.automation.autoQueue),
			highlightMoves: bool(automation.highlightMoves, D.automation.highlightMoves),
			highlightStyle: oneOf(automation.highlightStyle, D.automation.highlightStyle, HIGHLIGHT_STYLES),
		},
		keybinds: {
			playMove: keybind(keybinds.playMove, D.keybinds.playMove),
			toggleAutoMove: keybind(keybinds.toggleAutoMove, D.keybinds.toggleAutoMove),
			disable: keybind(keybinds.disable, D.keybinds.disable),
			speakMove: keybind(keybinds.speakMove, D.keybinds.speakMove),
			global: bool(keybinds.global, D.keybinds.global),
		},
		display: {
			evalBar: bool(display.evalBar, D.display.evalBar),
			pvCount: intIn(display.pvCount, D.display.pvCount, LIMITS.multiPvMin, LIMITS.multiPvMax),
			uiSounds: bool(display.uiSounds, D.display.uiSounds),
			tts: bool(display.tts, D.display.tts),
			ttsVoice: typeof display.ttsVoice === "string" ? display.ttsVoice : D.display.ttsVoice,
			theme: oneOf(display.theme, D.display.theme, THEMES),
			reducedMotion: oneOf(display.reducedMotion, D.display.reducedMotion, REDUCED_MOTION),
		},
		engine: {
			threads: threads(engine.threads, D.engine.threads),
			hashMb: intIn(engine.hashMb, D.engine.hashMb, LIMITS.hashMbMin, LIMITS.hashMbMax),
			depthCap: intIn(engine.depthCap, D.engine.depthCap, LIMITS.depthMin, LIMITS.depthMax),
			multiPv: intIn(engine.multiPv, D.engine.multiPv, LIMITS.multiPvMin, LIMITS.multiPvMax),
			nnue: oneOf(engine.nnue, D.engine.nnue, NNUE),
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
