/**
 * A dependant is disabled while its switch is off (settings layout, 2026-09-13): the rows sit
 * directly beneath the control they depend on, and the dimming says why. Everything is disabled
 * while the view is locked.
 */

import type { Settings } from "@typedefs/settings";
import type { SettingsLeafPath } from "./rows";

export function disabledFor(path: SettingsLeafPath, settings: Settings, locked: boolean): boolean {
	if (locked) return true;
	const { strength, automation, display } = settings;
	switch (path) {
		case "strength.targetElo":
			return strength.matchOpponentRating;
		case "strength.personaEloOffset":
			return !strength.matchOpponentRating;
		case "automation.rematchTitled":
			return !automation.autoQueue;
		case "automation.highlightStyle":
			return !automation.highlightMoves;
		case "automation.freeTitleBadge":
			return !automation.freeTitle;
		// Move ratings and board effects are independent (owner, 2026-09-15): nothing in the
		// ratings chain waits on board effects.
		case "automation.moveQualityChipsFor":
		case "automation.moveRatingSounds":
			return !automation.moveQualityChips;
		case "automation.forcedMateSounds":
			return !automation.moveQualityChips || !automation.moveRatingSounds;
		case "display.cursorEffects":
			return !display.virtualCursor;
		default:
			return (
				(path.startsWith("automation.autoQueueSession") ||
					path.startsWith("automation.autoQueueBreak")) &&
				!automation.autoQueue
			);
	}
}
