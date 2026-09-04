/**
 * Message-type registry and port contracts (§4.3). This is the only place
 * message `type` strings exist; handlers register by constant. The
 * request/response map (`MessageResponseMap`) lives in
 * `src/core/messaging/typed-messages.ts` (Task 4).
 */

import type { EngineStatus, EngineVariant, EvalLine } from "@typedefs/engine";
import type {
	ChosenMove,
	GameMeta,
	GameResult,
	GameSessionView,
	HighlightStyle,
	PageKind,
	PositionSnapshot,
	Recommendation,
	SessionStats,
	Site,
	Square,
} from "@typedefs/game";
import type { Keybinds, LicenseState, Settings } from "@typedefs/settings";
import type { TimingLogEntry, TimingPlan } from "@typedefs/timing";

export type { ChosenMove, EvalLine, PositionSnapshot, Recommendation, TimingPlan };

export const MSG = {
	// panel → SW (request/response)
	PANEL_GET_SNAPSHOT: "sl:panel:getSnapshot",
	PANEL_PLAY_NOW: "sl:panel:playNow",
	PANEL_SET_AUTO_MOVE: "sl:panel:setAutoMove",
	PANEL_CANCEL_PENDING: "sl:panel:cancelPending",
	PANEL_SET_ENABLED: "sl:panel:setEnabled",
	PANEL_PREVIEW_LINE: "sl:panel:previewLine",
	PANEL_LOGIN: "sl:panel:login",
	PANEL_LOGOUT: "sl:panel:logout",
	PANEL_RECHECK_LICENSE: "sl:panel:recheckLicense",
	PANEL_ENGINE_RESTART: "sl:panel:engineRestart",
	PANEL_EXPORT_TIMING_LOG: "sl:panel:exportTimingLog",
	// content → SW (request/response)
	CONTENT_HELLO: "sl:content:hello",
	CONTENT_KEYBIND: "sl:content:keybind",
	CONTENT_CURSOR: "sl:content:cursor",
	// SW → content (fire-and-forget)
	CONTENT_HIGHLIGHT: "sl:content:highlight",
	CONTENT_CLEAR_HIGHLIGHT: "sl:content:clearHighlight",
	CONTENT_SET_KEYBINDS: "sl:content:setKeybinds",
	CONTENT_START_NEW_GAME: "sl:content:startNewGame",
	// offscreen ↔ SW (also via port)
	OFFSCREEN_PING: "sl:offscreen:ping",
	OFFSCREEN_ENGINE_STATUS: "sl:offscreen:engineStatus",
	// shared
	LOG: "sl:log",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

/** Full panel state (on connect + on change, ≤10 Hz). */
export interface PanelSnapshot {
	license: LicenseState;
	site: Site | null;
	pageKind: PageKind;
	session: GameSessionView;
	engine: EngineStatus;
	executor: { debuggerAttached: boolean; lastError?: string };
	settings: Settings;
	recommendation?: Recommendation;
	autoMove: { armed: boolean; scheduledAt?: number; plan?: TimingPlan };
	stats: SessionStats;
	/** V2 §13.4, V2.1 §13.5 */
	focus: {
		pageHasFocus: boolean;
		blurSeenThisMove: boolean;
		handsOff: boolean;
		realPointerEventsDuringHand: number;
	};
	/** V2 §13.6 */
	opponent?: {
		isBot: boolean;
		name: string;
		ratingEstimate: number | null;
		derivedTargetElo: number;
	};
}

// Port payloads

/** SW → panel */
export type PanelPortMessage =
	| { kind: "snapshot"; snapshot: PanelSnapshot }
	| { kind: "toast"; level: "info" | "warn" | "error"; text: string }
	| { kind: "timingLog"; entry: TimingLogEntry };

/** content → SW */
export type GamePortMessage =
	| { kind: "hello"; site: Site; pageKind: PageKind; adapterVersion: string }
	| { kind: "position"; snapshot: PositionSnapshot }
	| { kind: "gameStarted"; game: GameMeta }
	| { kind: "gameEnded"; result: GameResult }
	| { kind: "cursor"; x: number; y: number; t: number; real: true }
	| { kind: "selectorMiss"; selector: string }
	/** V2 §13.4: every window focus/blur/visibilitychange edge */
	| { kind: "focus"; hasFocus: boolean; visibility: "visible" | "hidden"; at: number }
	/** V2 §13.6: opponent identity for matchOpponentRating */
	| { kind: "opponent"; isBot: boolean; name: string; ratingEstimate: number | null }
	| { kind: "moveObserved"; san: string; ply: number; byMe: boolean; atMs: number };

/** SW → content */
export type GamePortCommand =
	| { kind: "highlight"; from: Square; to: Square; style: HighlightStyle }
	| { kind: "clearHighlight" }
	| { kind: "arrow"; lines: Array<{ from: Square; to: Square; weight: number }> }
	| { kind: "keybinds"; keybinds: Keybinds }
	| { kind: "startNewGame" }
	| { kind: "speak"; text: string };

/**
 * A slice of a net relayed by the SW (`handlers/engine/nnue-download.ts`).
 * `chrome.runtime` ports JSON-serialise their payloads (crbug.com/248548: no
 * structured clone), so an `ArrayBuffer` would arrive as `{}`; the raw bytes
 * (`LIMITS.nnueChunkBytes` per chunk) travel base64-encoded instead.
 */
export type NnueChunk =
	| { kind: "nnue-chunk"; name: string; index: number; total: number; bytes: string }
	| { kind: "nnue-chunk"; name: string; error: string };

/** Inputs of one timing-head inference (Task 34 defines the feature vector). */
export type TimingInferenceInputs = Record<string, number>;

/** offscreen → SW */
export type EnginePortMessage =
	| { kind: "line"; line: string }
	| { kind: "status"; status: EngineStatus }
	| { kind: "nnue"; progress: number }
	/** Ask the SW to download a net that is neither bundled nor cached (Task 12). */
	| { kind: "nnue-request"; name: string }
	/** Download/reassembly progress in `[0, 1]` for `name`. */
	| { kind: "nnue-progress"; name: string; progress: number }
	/** Reply to a `timing` command (`probs: null` + `error` when unavailable). */
	| { kind: "timing-result"; id: string; probs: Record<string, number> | null; error?: string };

/** SW → offscreen */
export type EnginePortCommand =
	| { kind: "uci"; line: string }
	| { kind: "restart" }
	| { kind: "loadNnue"; names: string[] }
	/** Which build to run and how many threads the SW will ask for (first one boots the engine). */
	| { kind: "configure"; variant: EngineVariant; threads: number }
	| NnueChunk
	/** Timing-head inference request (Task 34); answered with `timing-result`. */
	| { kind: "timing"; id: string; inputs: TimingInferenceInputs };
