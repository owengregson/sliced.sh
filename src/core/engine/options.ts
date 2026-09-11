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
/** Auto thread selection leaves cores for the page (Appendix E §4.3). */
const AUTO_THREADS_MAX = 4;
const AUTO_THREADS_RESERVE = 2;
/** `UCI_LimitStrength` runs `MultiPV = max(MultiPV, 4)` internally (§7.1). */
const MULTI_PV_FLOOR = 4;

export const ENGINE_OPTION_DEFAULTS: Readonly<Required<EngineOptions>> = Object.freeze({
	Threads: 1,
	Hash: LIMITS.hashMbMin,
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

export interface OptionsEnv {
	hardwareConcurrency: number;
	/** `SharedArrayBuffer` available (cross-origin isolated): the multi-threaded build runs. */
	sab: boolean;
}

/** Higher targets require the full network, including an old persisted Small preference. */
export function variantForSettings(settings: Settings): EngineVariant {
	return settings.strength.targetElo > LIMITS.nnueSmallEloMax || settings.engine.nnue === "big"
		? "full"
		: "smallnet";
}

/**
 * Settings → options: full-strength search with the engine's Elo limiter on
 * (§7.1 hybrid), WDL on for the panel, no UCI ponder mode (Appendix E §4.2).
 * Threads (§6.1): `auto` → `clamp(hardwareConcurrency − 2, 1, 4)`; without
 * `SharedArrayBuffer` the single-threaded build runs, so always 1.
 */
export function optionsForSettings(settings: Settings, env: OptionsEnv): EngineOptions {
	const { engine, strength } = settings;
	let threads: number;
	if (!env.sab) threads = 1;
	else if (engine.threads === "auto")
		threads = clampInt(env.hardwareConcurrency - AUTO_THREADS_RESERVE, 1, AUTO_THREADS_MAX);
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
