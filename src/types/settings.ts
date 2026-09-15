/**
 * Settings and license types (§4.4) plus `DEFAULT_KEYBINDS` / `DEFAULT_SETTINGS`
 * — the ONLY definition of the defaults (`@core/constants/defaults` re-exports).
 */

import { LIMITS } from "@core/constants/limits";

export type PersonaId = "cautious" | "balanced" | "aggressive" | "blitz";
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface Keybind {
	key: string;
	code: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/**
 * Keys marked **forced** below are decided by the extension (owner, 2026-09-12): the Settings view
 * shows no control, and `normalizeSettings` overwrites any stored value with
 * `FORCED_SETTING_VALUES` (`@core/constants/defaults`) on every read. Patches for them are still
 * accepted by `setSettings` — the normaliser simply wins — so the keys, the types and the code
 * behind them are unchanged.
 */
export interface Settings {
	enabled: boolean;
	strength: {
		targetElo: number;
		/** V2.1: derives targetElo from the opponent (§13.6). */
		matchOpponentRating: boolean;
		personaEloOffset: number;
		/** Forced: `balanced`. */
		persona: PersonaId;
		/** Forced: `hybrid`. */
		selectionMode: "engine-elo" | "persona-sampling" | "hybrid";
		useOpeningBook: boolean;
		/**
		 * 0..2, default 1. H2 (2026-09-13): an Elo offset on the rating the human model is asked
		 * about, `MAIA.slider.eloSpan · (blunderScale − 1)` *below* the target. The Settings view
		 * shows it as **Accuracy offset** in Elo with the intuitive sign (+150 = plays as a
		 * 150-higher rating would); the leaf keeps the 0–2 unit the blunder channel reads.
		 */
		blunderScale: number;
	};
	timing: {
		profile: "manual" | "fast" | "natural" | "slow" | "custom";
		speedScale: number;
		varianceScale: number;
		premoveTendency: number;
		longThinkFrequency: number;
		/** Forced: `true` (off ignored the clock entirely; the clock-free schedule stays in code). */
		respectBudget: boolean;
	};
	execution: {
		motorSpeed: number;
		/** Forced: `true`. */
		keepDebuggerAttached: boolean;
		verifyMoves: boolean;
		/** Forced: `false` (the calibration code stays; the row is gone). */
		calibrateFromMyMouse: boolean;
		/** Forced: `cdp` (the `native` path stays in code, no longer offered). */
		backend: "cdp" | "native";
		/**
		 * 0..2, multiplies the modelled preview-selection rate (V2.1); **0 is Off** — the former
		 * `previewSelects` segment folded into the slider (settings layout, 2026-09-13).
		 */
		previewSelectScale: number;
		/**
		 * How the hand commits a move: `drag` (press, carry, release), `click` (click the piece,
		 * click the square), or `auto` — a per-move mix, mostly drags (`CLICK_MOVE.autoClickProb`).
		 * Premoves and holds are always drags. Owner, 2026-09-11 — reversing the 2026-09-10
		 * drag-only ruling, now as a setting so it is one toggle either way.
		 */
		inputMode: "auto" | "drag" | "click";
	};
	automation: {
		/**
		 * Lets the hand play on its own. Ships **off**: playing moves on a real
		 * account stays an explicit opt-in (arming also attaches the debugger, §13.4).
		 */
		autoMove: boolean;
		/**
		 * The armed hand resigns a forced mate against us in at most `RESIGN.maxMateIn` moves
		 * instead of playing it out (2026-09-12); off plays every position to the end.
		 */
		resignLostGames: boolean;
		autoQueue: boolean;
		/** Playing-session duration range. An active game always finishes before a break. */
		autoQueueSessionMinMinutes: number;
		autoQueueSessionMaxMinutes: number;
		/** Break duration range between playing sessions, sampled once per break. */
		autoQueueBreakMinMinutes: number;
		autoQueueBreakMaxMinutes: number;
		/**
		 * A queue step (2026-09-13): after a game against a titled opponent, offer one rematch — or
		 * accept theirs — before queueing a regular game; an offer not taken within
		 * `REMATCH.acceptTimeoutMs` is dismissed. Once per opponent per playing session. Ships on;
		 * inert unless `autoQueue` is on.
		 */
		rematchTitled: boolean;
		/**
		 * Draws the recommendation on the board. Ships **on** so a fresh install shows
		 * something; §13.3 rule 4 still holds at runtime — the content script draws
		 * nothing until the service worker sends `settings`.
		 */
		highlightMoves: boolean;
		highlightStyle: "squares" | "arrows" | "both";
		/**
		 * Board effects (owner's brief, 2026-09-13): after every move, either side's, draw what it
		 * did — threats, checks, forks, discoveries, pins, captures, castles, promotions — as
		 * directional rays from the destination square, plus a move-quality chip on it. Ships
		 * **on**, following `highlightMoves`, and like it the content script draws nothing until
		 * the service worker sends `settings` (§13.3 rule 4).
		 */
		boardEffects: boolean;
		/**
		 * The move-quality chip of the effect layer (settings layout, 2026-09-13): the one board
		 * element that shows an evaluation, and the only part of board effects that costs engine
		 * time. Off: the rays still draw; no verdict is searched or sent. Inert unless
		 * `boardEffects` is on.
		 */
		moveQualityChips: boolean;
		/** Play a matching sound when either side's move rating appears. */
		moveRatingSounds: boolean;
	};
	keybinds: {
		playMove: Keybind;
		toggleAutoMove: Keybind;
		disable: Keybind;
		speakMove: Keybind;
		/** Forced: `false` (Chrome's own shortcuts always work; the page scope is the keybinds'). */
		global: boolean;
	};
	display: {
		evalBar: boolean;
		uiSounds: boolean;
		tts: boolean;
		ttsVoice: string | null;
		theme: "dark" | "light" | "system";
		reducedMotion: "system" | "on" | "off";
		/**
		 * Fix D: draw a mirror of the hand's own pointer on the game page, so the owner can see
		 * where it is. It tracks only what the executor dispatched — never the real mouse — and is
		 * present only while the hand owns the pointer on that tab.
		 */
		virtualCursor: boolean;
		/** The mirror's motion feedback: the press dip and contour, and the ghost trail behind it. */
		cursorEffects: boolean;
	};
	engine: {
		threads: number | "auto";
		hashMb: number;
		depthCap: number;
		/**
		 * "Lines": the minimum number of lines the engine searches *and* the number the Game view
		 * shows — one knob since 2026-09-13 (the former `display.pvCount` merged into it).
		 */
		multiPv: number;
		/** Forced: `auto` (the network follows the active Elo). */
		nnue: "small" | "big" | "auto";
	};
	advanced: {
		logLevel: LogLevel;
		timingLogEnabled: boolean;
	};
}

export type Keybinds = Settings["keybinds"];

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
		profile: "natural",
		speedScale: 1,
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
		moveQualityChips: true,
		moveRatingSounds: false,
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

export interface LicenseState {
	status: "unknown" | "valid" | "invalid" | "ip_limit" | "expired" | "network_error";
	/** V2: the endpoint's real verdict when LICENSE_FORCE_VALID. */
	rawStatus?: LicenseState["status"];
	checkedAt: number;
	expiresAt?: number;
	message?: string;
}
