/**
 * Settings and license types (§4.4) plus `DEFAULT_KEYBINDS` / `DEFAULT_SETTINGS`
 * — the ONLY definition of the defaults (`@core/constants/defaults` re-exports).
 */

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

export interface Settings {
	enabled: boolean;
	strength: {
		targetElo: number;
		/** V2.1: derives targetElo from the opponent (§13.6). */
		matchOpponentRating: boolean;
		personaEloOffset: number;
		persona: PersonaId;
		selectionMode: "engine-elo" | "persona-sampling" | "hybrid";
		useOpeningBook: boolean;
		/** 0..2 */
		blunderScale: number;
	};
	timing: {
		profile: "manual" | "fast" | "natural" | "slow" | "custom";
		speedScale: number;
		varianceScale: number;
		premoveTendency: number;
		longThinkFrequency: number;
		respectBudget: boolean;
	};
	execution: {
		motorSpeed: number;
		keepDebuggerAttached: boolean;
		verifyMoves: boolean;
		calibrateFromMyMouse: boolean;
		backend: "cdp" | "native";
		previewSelects: "auto" | "off";
		/** 0.5..2, multiplies the model rate (V2.1). */
		previewSelectScale: number;
	};
	automation: {
		/**
		 * Lets the hand play on its own. Ships **off**: playing moves on a real
		 * account stays an explicit opt-in (arming also attaches the debugger, §13.4).
		 */
		autoMove: boolean;
		autoQueue: boolean;
		/**
		 * Draws the recommendation on the board. Ships **on** so a fresh install shows
		 * something; §13.3 rule 4 still holds at runtime — the content script draws
		 * nothing until the service worker sends `settings`.
		 */
		highlightMoves: boolean;
		highlightStyle: "squares" | "arrows" | "both";
	};
	keybinds: {
		playMove: Keybind;
		toggleAutoMove: Keybind;
		disable: Keybind;
		speakMove: Keybind;
		global: boolean;
	};
	display: {
		evalBar: boolean;
		pvCount: number;
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
	};
	engine: {
		threads: number | "auto";
		hashMb: number;
		depthCap: number;
		multiPv: number;
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
		personaEloOffset: 50,
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
		previewSelects: "auto",
		previewSelectScale: 1,
	},
	automation: { autoMove: false, autoQueue: false, highlightMoves: true, highlightStyle: "both" },
	keybinds: { ...DEFAULT_KEYBINDS, global: false },
	display: {
		evalBar: true,
		pvCount: 3,
		uiSounds: true,
		tts: false,
		ttsVoice: null,
		theme: "dark",
		reducedMotion: "system",
		virtualCursor: true,
	},
	engine: { threads: "auto", hashMb: 32, depthCap: 22, multiPv: 4, nnue: "auto" },
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
