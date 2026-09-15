/**
 * Engine options (§6.4 `options.ts`): defaults, clamps from `LIMITS`, the
 * `setoption` wire encoding and the settings → options mapping used by the
 * engine controller (Task 13).
 */

import { LIMITS } from "@core/constants/limits";
import { clampInt } from "@core/util/clamp";
import type { EngineVariant } from "@typedefs/engine";
import type { Settings } from "@typedefs/settings";
import type { EngineOptions, EngineOptionValue } from "./types";

export type { EngineOptions } from "./types";

/** Stockfish's `Skill Level` range. */
const SKILL_LEVEL_MAX = 20;
/** Stockfish's `Move Overhead` range (ms). */
const MOVE_OVERHEAD_MAX = 5000;
/** `UCI_LimitStrength` runs `MultiPV = max(MultiPV, 4)` internally (§7.1). */
const MULTI_PV_FLOOR = 4;

/**
 * Fallbacks for an option `optionsForSettings` did not resolve (it always resolves all of them);
 * `Threads` / `Hash` are the owner's 2026-09-13 defaults (`LIMITS.threadsDefault`, `hashMbDefault`).
 */
export const ENGINE_OPTION_DEFAULTS: Readonly<Required<EngineOptions>> = Object.freeze({
	Threads: LIMITS.threadsDefault,
	Hash: LIMITS.hashMbDefault,
	MultiPV: MULTI_PV_FLOOR,
	UCI_ShowWDL: true,
	UCI_LimitStrength: false,
	UCI_Elo: LIMITS.engineEloMin,
	"Skill Level": SKILL_LEVEL_MAX,
	Ponder: false,
	"Move Overhead": 10,
});

type NumericOption = {
	[K in keyof EngineOptions]-?: EngineOptions[K] extends number | undefined ? K : never;
}[keyof EngineOptions];

const CLAMPS: Readonly<Record<NumericOption, readonly [number, number]>> = {
	Threads: [1, LIMITS.threadsMax],
	Hash: [LIMITS.hashMbMin, LIMITS.hashMbMax],
	MultiPV: [LIMITS.multiPvMin, LIMITS.multiPvMax],
	UCI_Elo: [LIMITS.engineEloMin, LIMITS.engineEloMax],
	"Skill Level": [0, SKILL_LEVEL_MAX],
	"Move Overhead": [0, MOVE_OVERHEAD_MAX],
};

function isNumericOption(name: string): name is NumericOption {
	return Object.hasOwn(CLAMPS, name);
}

/** Clamp every numeric option present to its Stockfish / `LIMITS` range. */
export function clampEngineOptions(opts: Partial<EngineOptions>): Partial<EngineOptions> {
	const out: Partial<EngineOptions> = { ...opts };
	for (const [name, value] of Object.entries(opts)) {
		if (typeof value === "number" && isNumericOption(name)) {
			const [min, max] = CLAMPS[name];
			out[name] = clampInt(value, min, max);
		}
	}
	return out;
}

/** `setoption name <Name> value <v>` — names may contain spaces, booleans are `true`/`false`. */
export function formatSetOption(name: string, value: EngineOptionValue): string {
	return `setoption name ${name} value ${String(value)}`;
}

/** Native strength for one session's active target; an absent Elo requests full search. */
export function requestEloForTarget(targetElo: number): number | undefined {
	return targetElo > LIMITS.engineEloMax
		? undefined
		: clampInt(targetElo, LIMITS.engineEloMin, LIMITS.engineEloMax);
}

export interface OptionsEnv {
	hardwareConcurrency: number;
	/** `SharedArrayBuffer` available (cross-origin isolated): the multi-threaded build runs. */
	sab: boolean;
}

/** Higher active targets require the full network; an explicit Big preference always wins. */
export function variantForSettings(
	settings: Settings,
	targetElo = settings.strength.targetElo
): EngineVariant {
	const target = Number.isFinite(targetElo) ? targetElo : settings.strength.targetElo;
	return target > LIMITS.nnueSmallEloMax || settings.engine.nnue === "big" ? "full" : "smallnet";
}

/**
 * `auto` threads (owner, 2026-09-13): `min(LIMITS.threadsDefault, hardwareConcurrency)`, at
 * least 1 — 8 on most devices, every core on a smaller one. The former Appendix E §4.3 formula
 * (`clamp(cores − 2, 1, 4)`) reserved cores for the page; the owner asked for the engine to have
 * them. A missing or non-finite core count (no `navigator` in the runtime) counts as 1.
 */
export function autoThreads(hardwareConcurrency: number): number {
	const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 1;
	return clampInt(cores, 1, LIMITS.threadsDefault);
}

/**
 * Settings → options: full-strength search with the engine's Elo limiter on
 * (§7.1 hybrid), WDL on for the panel, no UCI ponder mode (Appendix E §4.2).
 * Threads (§6.1): `auto` → `autoThreads(hardwareConcurrency)`; an explicit setting is kept
 * (clamped to `LIMITS.threadsMax`); without `SharedArrayBuffer` the single-threaded build runs,
 * so always 1.
 */
export function optionsForSettings(settings: Settings, env: OptionsEnv): EngineOptions {
	const { engine, strength } = settings;
	let threads: number;
	if (!env.sab) threads = 1;
	else if (engine.threads === "auto") threads = autoThreads(env.hardwareConcurrency);
	else threads = engine.threads;
	const clamped = clampEngineOptions({
		Threads: threads,
		Hash: engine.hashMb,
		MultiPV: Math.max(engine.multiPv, MULTI_PV_FLOOR),
		UCI_Elo: strength.targetElo,
	});
	return {
		Threads: clamped.Threads ?? ENGINE_OPTION_DEFAULTS.Threads,
		Hash: clamped.Hash ?? ENGINE_OPTION_DEFAULTS.Hash,
		MultiPV: clamped.MultiPV ?? ENGINE_OPTION_DEFAULTS.MultiPV,
		// The native engine only calibrates 1320–3190. Above that range use full search,
		// with the product's selection policy below its maximum endpoint.
		UCI_LimitStrength: strength.targetElo <= LIMITS.engineEloMax,
		UCI_Elo: clamped.UCI_Elo ?? ENGINE_OPTION_DEFAULTS.UCI_Elo,
		UCI_ShowWDL: true,
		Ponder: false,
	};
}
