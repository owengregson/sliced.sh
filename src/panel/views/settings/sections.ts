/**
 * Section layout of the Settings view (Appendix F §4.6): the seven sections in order, each with
 * the row paths it shows. Account and Advanced carry extra non-setting elements (license, plan,
 * device, sign out; export / reset) that `settings.ts` renders after the rows.
 */

import { SETTINGS_COPY } from "../../copy";
import type { SettingsLeafPath } from "./rows";

export type SectionId = keyof typeof SETTINGS_COPY.sections;

export interface SectionSpec {
	id: SectionId;
	title: string;
	rows: readonly SettingsLeafPath[];
}

const section = (id: SectionId, rows: readonly SettingsLeafPath[]): SectionSpec => ({
	id,
	title: SETTINGS_COPY.sections[id],
	rows,
});

export const SECTIONS: readonly SectionSpec[] = [
	section("strength", [
		"strength.matchOpponentRating",
		"strength.personaEloOffset",
		"strength.targetElo",
		"strength.persona",
		"strength.selectionMode",
		"strength.blunderScale",
		"strength.useOpeningBook",
	]),
	section("timing", [
		"timing.profile",
		"timing.speedScale",
		"timing.varianceScale",
		"timing.premoveTendency",
		"timing.longThinkFrequency",
		"timing.respectBudget",
	]),
	section("execution", [
		"enabled",
		"automation.autoMove",
		"automation.autoQueue",
		"execution.style",
		"execution.motorSpeed",
		"execution.calibrateFromMyMouse",
		"execution.previewSelects",
		"execution.previewSelectScale",
		"execution.backend",
		"execution.keepDebuggerAttached",
		"execution.verifyMoves",
	]),
	section("keybinds", [
		"keybinds.playMove",
		"keybinds.toggleAutoMove",
		"keybinds.disable",
		"keybinds.speakMove",
		"keybinds.global",
	]),
	section("display", [
		"automation.highlightMoves",
		"automation.highlightStyle",
		"display.evalBar",
		"display.pvCount",
		"display.uiSounds",
		"display.tts",
		"display.ttsVoice",
		"display.theme",
		"display.reducedMotion",
	]),
	section("account", []),
	section("advanced", [
		"engine.threads",
		"engine.hashMb",
		"engine.depthCap",
		"engine.multiPv",
		"engine.nnue",
		"advanced.logLevel",
		"advanced.timingLogEnabled",
	]),
];
