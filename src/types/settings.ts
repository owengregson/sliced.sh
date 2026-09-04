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
		style: "drag" | "click" | "auto";
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
		autoMove: boolean;
		autoQueue: boolean;
		/** V2 default false, §13.3. */
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
	enabled: false,
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
		style: "auto",
		motorSpeed: 1,
		keepDebuggerAttached: true,
		verifyMoves: true,
		calibrateFromMyMouse: false,
		backend: "cdp",
		previewSelects: "auto",
		previewSelectScale: 1,
	},
	automation: { autoMove: false, autoQueue: false, highlightMoves: false, highlightStyle: "both" },
	keybinds: { ...DEFAULT_KEYBINDS, global: false },
	display: {
		evalBar: true,
		pvCount: 3,
		uiSounds: true,
		tts: false,
		ttsVoice: null,
		theme: "dark",
		reducedMotion: "system",
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
