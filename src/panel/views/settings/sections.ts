/** Outcome-based settings sections. Dependants remain adjacent to their controlling switch;
 * timing and hand controls share a section because they share the overall move clock.
 * Account and Diagnostics add actions in settings.ts.
 */

import type { FORCED_SETTING_VALUES } from "@core/constants/defaults";
import { KEYBIND_SCOPE_FORCED, RESPECT_BUDGET_FORCED, SETTINGS_COPY } from "../../copy";
import type { LeafPaths, SettingsLeafPath } from "./rows";

export type SectionId = keyof typeof SETTINGS_COPY.sections;

export interface SectionSpec {
	id: SectionId;
	title: string;
	help: string;
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
	help: SETTINGS_COPY.sectionHelp[id],
	rows,
});

/** Internal values that intentionally have no settings control. */
export const MANAGED_SETTINGS = {
	"automation.autoMove": "The Game switch owns saved auto-play intent.",
	"strength.blunderScale":
		"Legacy accuracy offset is normalized to neutral; target Elo owns accuracy.",
	"display.tts": "Speech is requested with the shortcut, never automatically.",
} satisfies Partial<Record<SettingsLeafPath, string>>;

export const SECTIONS: readonly SectionSpec[] = [
	// The one number every session is about. Target first (owner); matching replaces it, the
	// persona offset only applies while matching.
	section("strength", [
		"strength.targetElo",
		"strength.matchOpponentRating",
		"strength.personaEloOffset",
		"strength.useOpeningBook",
		"strength.useTablebase",
	]),
	// Session behavior; auto-play itself is controlled only from Game.
	section("automation", [
		"enabled",
		"automation.resignLostGames",
		"automation.autoQueue",
		"automation.autoQueueSessionMinMinutes",
		"automation.autoQueueSessionMaxMinutes",
		"automation.autoQueueBreakMinMinutes",
		"automation.autoQueueBreakMaxMinutes",
		"automation.rematchTitled",
	]),
	// When the hand plays: the user's own knobs, the whole-move speed first (2026-09-15: the
	// preset row that used to head this section went with the timing presets).
	section("timing", [
		"timing.baseSpeed",
		"timing.varianceScale",
		"timing.longThinkFrequency",
		"timing.premoveTendency",
		// The same overall time includes the hand and input method.
		"execution.inputMode",
		"execution.motorSpeed",
		"execution.previewSelectScale",
		"execution.verifyMoves",
		"display.virtualCursor",
		"display.cursorEffects",
	]),
	// What is drawn on chess.com's board, each dependant beneath its switch. Move ratings sits
	// beneath board effects as its neighbour, not its dependant (2026-09-15: independent switches).
	section("board", [
		"automation.highlightMoves",
		"automation.highlightStyle",
		"automation.boardEffects",
		"automation.moveQualityChips",
		"automation.moveQualityChipsFor",
		"automation.moveRatingSounds",
		"automation.forcedMateSounds",
		"automation.freeTitle",
		"automation.freeTitleBadge",
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
