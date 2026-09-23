/**
 * `DEFAULT_KEYBINDS` / `DEFAULT_SETTINGS` — the ONLY definition of the defaults
 * (`@core/constants/defaults` re-exports).
 */

import { LIMITS } from "@core/constants/limits";
import type { Keybinds, Settings } from "./schema";

export const DEFAULT_KEYBINDS: Readonly<Omit<Keybinds, "global">> = Object.freeze({
	playMove: {
		key: " ",
		code: "Space",
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	},
	toggleAutoMove: {
		key: "a",
		code: "KeyA",
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: true,
	},
	disable: { key: "x", code: "KeyX", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true },
	speakMove: {
		key: "w",
		code: "KeyW",
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	},
});

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze<Settings>({
	// A fresh install assists (highlights + recommendations) but never moves by itself:
	// `automation.autoMove` is the explicit opt-in, and nothing else ships inert.
	enabled: true,
	strength: {
		targetElo: 1500,
		matchOpponentRating: true,
		// Owner, 2026-09-13: "+150 (not +50) — just shift the setting default". A default change
		// only reaches fresh installs and resets; `normalizeSettings` keeps any stored offset.
		personaEloOffset: 150,
		persona: "balanced",
		selectionMode: "hybrid",
		useOpeningBook: true,
		blunderScale: 1,
	},
	timing: {
		baseSpeed: 1,
		varianceScale: 1,
		premoveTendency: 0.5,
		longThinkFrequency: 1,
		respectBudget: true,
	},
	execution: {
		motorSpeed: 1,
		keepDebuggerAttached: true,
		verifyMoves: true,
		calibrateFromMyMouse: false,
		backend: "cdp",
		// The user sees 1.0×; the hand runs at `SETTING_GAIN.previewSelectScale` (1.25) times this
		// (owner, 2026-09-13: "preview rate 1.0x = 1.25x"). This had been 1.1× since 2026-09-11 for
		// the same "more thinking selections" reason; the gain now carries that, in one place.
		previewSelectScale: 1,
		inputMode: "auto",
	},
	automation: {
		autoMove: false,
		resignLostGames: true,
		autoQueue: false,
		autoQueueSessionMinMinutes: 20,
		autoQueueSessionMaxMinutes: 60,
		autoQueueBreakMinMinutes: 5,
		autoQueueBreakMaxMinutes: 20,
		rematchTitled: true,
		highlightMoves: true,
		highlightStyle: "both",
		boardEffects: true,
		freeTitle: false,
		freeTitleBadge: "GM",
		moveQualityChips: true,
		moveQualityChipsFor: "both",
		moveRatingSounds: false,
		forcedMateSounds: true,
	},
	keybinds: { ...DEFAULT_KEYBINDS, global: false },
	display: {
		evalBar: true,
		uiSounds: true,
		tts: false,
		ttsVoice: null,
		theme: "dark",
		reducedMotion: "system",
		virtualCursor: true,
		cursorEffects: true,
	},
	engine: {
		threads: "auto",
		hashMb: LIMITS.hashMbDefault,
		depthCap: 22,
		multiPv: 4,
		nnue: "auto",
	},
	advanced: { logLevel: "info", timingLogEnabled: true },
});
