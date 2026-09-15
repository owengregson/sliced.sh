/**
 * Section layout of the Settings view (settings layout, 2026-09-13 —
 * `docs/qa/settings-layout-2026-09-13.md` has the rationale): the ten sections in order, each
 * with the row paths it shows. Most-used and most-consequential first; a control's dependants
 * directly beneath it; paired ranges adjacent; dangerous and rare last. Account and Advanced
 * carry extra non-setting elements (license, plan, device, sign out; export / reset) that
 * `settings.ts` renders after the rows.
 */

import type { FORCED_SETTING_VALUES } from "@core/constants/defaults";
import { KEYBIND_SCOPE_FORCED, RESPECT_BUDGET_FORCED, SETTINGS_COPY } from "../../copy";
import type { LeafPaths, SettingsLeafPath } from "./rows";

export type SectionId = keyof typeof SETTINGS_COPY.sections;

export interface SectionSpec {
	id: SectionId;
	title: string;
	rows: readonly SettingsLeafPath[];
}

/** A `Settings` leaf the extension decides — exactly the leaves of `FORCED_SETTING_VALUES`. */
export type ForcedSettingPath = LeafPaths<typeof FORCED_SETTING_VALUES> & SettingsLeafPath;

/**
 * Leaves of `Settings` / `DEFAULT_SETTINGS` that have no row because the extension decides them
 * (owner, 2026-09-12; settings layout, 2026-09-13), each with the one-line reason. The values
 * come from `FORCED_SETTING_VALUES` (`@core/constants/defaults`), which `normalizeSettings`
 * applies on every read; the `Record` type keeps this table and that registry in step. The
 * "every setting has a row" invariant in `test/panel/views/settings.test.ts` excludes exactly
 * these paths.
 */
export const FORCED_SETTINGS: Readonly<Record<ForcedSettingPath, string>> = {
	"strength.persona":
		"One persona (balanced); the persona model stays behind the timing and selection code.",
	"strength.selectionMode":
		"The hybrid selector is the product; engine-only and persona-only stay as code paths.",
	"timing.respectBudget": RESPECT_BUDGET_FORCED,
	"execution.calibrateFromMyMouse":
		"Calibration runs off the built-in profile; the calibration code stays.",
	"execution.backend":
		"The Chrome debugger is the only offered input backend; `native` stays as code.",
	"execution.keepDebuggerAttached":
		"The debugger attaches once before the game and stays attached (layout-shift rule).",
	"keybinds.global": KEYBIND_SCOPE_FORCED,
	"engine.nnue": "The network follows the active Elo (small below the cutoff, large above).",
};

const section = (id: SectionId, rows: readonly SettingsLeafPath[]): SectionSpec => ({
	id,
	title: SETTINGS_COPY.sections[id],
	rows,
});

export const SECTIONS: readonly SectionSpec[] = [
	// The one number every session is about. Target first (owner); matching replaces it, the
	// persona offset only applies while matching; the accuracy offset is the finer modifier.
	section("strength", [
		"strength.targetElo",
		"strength.matchOpponentRating",
		"strength.personaEloOffset",
		"strength.blunderScale",
		"strength.useOpeningBook",
	]),
	// Whether the assistant acts by itself: the master switch, the auto-play opt-in and what the
	// armed hand does on its own, then the queue with its ranges and its rematch step beneath.
	section("automation", [
		"enabled",
		"automation.autoMove",
		"automation.resignLostGames",
		"automation.autoQueue",
		"automation.autoQueueSessionMinMinutes",
		"automation.autoQueueSessionMaxMinutes",
		"automation.autoQueueBreakMinMinutes",
		"automation.autoQueueBreakMaxMinutes",
		"automation.rematchTitled",
	]),
	// When the hand plays: the preset, then the knobs the preset scales.
	section("timing", [
		"timing.profile",
		"timing.speedScale",
		"timing.varianceScale",
		"timing.longThinkFrequency",
		"timing.premoveTendency",
	]),
	// How the pointer commits a move.
	section("hand", [
		"execution.inputMode",
		"execution.motorSpeed",
		"execution.previewSelectScale",
		"execution.verifyMoves",
	]),
	// What is drawn on chess.com's board, each dependant beneath its switch.
	section("board", [
		"automation.highlightMoves",
		"automation.highlightStyle",
		"automation.boardEffects",
		"automation.moveQualityChips",
		"automation.moveRatingSounds",
		"display.virtualCursor",
		"display.cursorEffects",
	]),
	// This side panel: the Game view's content, then appearance, then feedback.
	section("panel", [
		"display.evalBar",
		"engine.multiPv",
		"display.theme",
		"display.reducedMotion",
		"display.uiSounds",
		"display.ttsVoice",
	]),
	section("keybinds", [
		"keybinds.playMove",
		"keybinds.toggleAutoMove",
		"keybinds.disable",
		"keybinds.speakMove",
	]),
	// Compute resources: consequential for the machine, set once.
	section("engine", ["engine.threads", "engine.hashMb", "engine.depthCap"]),
	section("account", []),
	section("advanced", ["advanced.logLevel", "advanced.timingLogEnabled"]),
];

/** Whether `id` names a section — a stale `ui.settingsCategory` from an older layout does not. */
export function isSectionId(id: string): id is SectionId {
	return SECTIONS.some((s) => s.id === id);
}
