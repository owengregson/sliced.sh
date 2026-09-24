/**
 * `normalizeSettings` — the single validation point for stored settings: it rebuilds a complete
 * `Settings` leaf by leaf over `DEFAULT_SETTINGS`, clamps numeric ranges with `LIMITS`, replaces
 * invalid enum values with defaults and silently drops unknown keys. The keys in
 * `FORCED_SETTING_VALUES` are overwritten with the forced value on every read.
 */

import { DEFAULT_SETTINGS, FORCED_SETTING_VALUES } from "@core/constants/defaults";
import { LIMITS } from "@core/constants/limits";
import type { Settings } from "@typedefs/settings";
import { baseSpeed, previewSelectScale } from "./migrations";
import {
	bool,
	CHIP_SIDES,
	HIGHLIGHT_STYLES,
	INPUT_MODES,
	intIn,
	isObj,
	keybind,
	LOG_LEVELS,
	minuteRange,
	num,
	numIn,
	type Obj,
	oneOf,
	REDUCED_MOTION,
	THEMES,
	threads,
} from "./readers";

/**
 * Validate an arbitrary value into a complete, fresh (unfrozen) `Settings`.
 *
 * Shapes from earlier builds still load: `automation.autoQueueDelay*` (per-game delays, dropped
 * 2026-09-11), `execution.style` (dropped 2026-09-10), `execution.previewSelects` (folded into
 * the rate, `./migrations`), `display.pvCount` (merged into `engine.multiPv`, 2026-09-13 — the
 * stored engine breadth wins, the display count is dropped), `timing.speedScale` (inverted into
 * `timing.baseSpeed`, `./migrations`), `timing.respectBudget` and `keybinds.global` (forced
 * since 2026-09-13). Unknown keys never survive a read.
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
			useTablebase: bool(strength.useTablebase, D.strength.useTablebase),
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
			freeTitle: bool(automation.freeTitle, D.automation.freeTitle),
			freeTitleBadge: oneOf(automation.freeTitleBadge, D.automation.freeTitleBadge, {
				GM: true,
				IM: true,
				NM: true,
				FM: true,
				CM: true,
			}),
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
