/**
 * Message-type registry and port contracts (§4.3). This is the only place
 * message `type` strings exist; handlers register by constant. The
 * request/response map (`MessageResponseMap`) lives in
 * `src/core/messaging/typed-messages.ts` (Task 4).
 */

import type { TOAST_KEYS } from "@core/constants/toasts";
import type { LogEntry } from "@core/logger";
import type { Occupancy, Rect } from "@core/motor/types";
import type { EngineStatus, EngineVariant, EvalLine } from "@typedefs/engine";
import type {
	ChosenMove,
	ExecutionResult,
	GameMeta,
	GameResult,
	GameSessionView,
	HighlightStyle,
	PageKind,
	PositionSnapshot,
	PromoPiece,
	Recommendation,
	SessionStats,
	Site,
	Square,
} from "@typedefs/game";
import type { Keybinds, LicenseState, LogLevel, Settings } from "@typedefs/settings";
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
	// Task 26 (engine & diagnostics view) — additive
	PANEL_CLEAR_TIMING_LOG: "sl:panel:clearTimingLog",
	PANEL_RESET_SESSION: "sl:panel:resetSession",
	/**
	 * The one debugger pair (Task 28 ruling): the Engine view's Detach releases the tab's
	 * debugger (and disarms the hand); Reattach — from the Live view's detached banner (§9.7)
	 * or the Engine view — attaches again and re-arms.
	 */
	PANEL_DETACH_DEBUGGER: "sl:panel:detachDebugger",
	PANEL_REATTACH_DEBUGGER: "sl:panel:reattachDebugger",
	// content → SW (request/response)
	CONTENT_HELLO: "sl:content:hello",
	CONTENT_KEYBIND: "sl:content:keybind",
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

/**
 * Task 18 request/reply pairs over the game port, correlated by `id`
 * (`ContentLink.request`). Geometry is read on demand right before the
 * approach (§9.5), never cached across scroll/resize; `promotion` carries the
 * picker rect once it is visible (`null` = never appeared, e.g. auto-queen).
 */
export interface BoardGeometryReply {
	boardRect: Rect;
	/** Per-square rects when the adapter has them; else derived from `boardRect` + `flipped`. */
	squares?: Partial<Record<Square, Rect>>;
	flipped: boolean;
	/** Adapter placement for the preview planner's deselect choice (§9.3a). */
	occupancy?: Partial<Record<Square, Occupancy>>;
	promotion?: Rect | null;
}

export interface ExpectedMove {
	from: Square;
	to: Square;
	promotion?: PromoPiece;
}

export type ToastLevel = "info" | "warn" | "error";

/** A port toast by registry key (`TOAST_KEYS`); the panel renders `COPY.toast[key]` (Task 28). */
export type PanelToast =
	| {
			key: typeof TOAST_KEYS.played;
			args: { san: string; elapsedMs: number; tier: ExecutionResult["tier"] };
	  }
	| { key: typeof TOAST_KEYS.notVerified }
	| { key: typeof TOAST_KEYS.reattached };

/** SW → panel */
export type PanelPortMessage =
	| { kind: "snapshot"; snapshot: PanelSnapshot }
	| ({ kind: "toast"; level: ToastLevel } & PanelToast)
	| { kind: "timingLog"; entry: TimingLogEntry };

/**
 * panel → SW, on every (re)connect: the window the panel lives in. A side-panel port's
 * `sender` carries no tab or window, so the snapshot's game tab is keyed on this (Task 28).
 */
export type PanelPortCommand = { kind: "hello"; windowId: number };

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
	/**
	 * §9.5: the 8×8 board's viewport rect moved or resized (a `ResizeObserver` on the board plus
	 * the window's own `resize` / `scroll` — all passive reads, §13.3). Sent only when the rect
	 * actually changed, so the service worker can tell a board that is still settling after the
	 * debugger's infobar appeared from one that has stopped, and can abort a drag whose coordinate
	 * space has moved out from under it rather than drop the piece on the wrong square.
	 *
	 * It carries no timestamp on purpose: `BoardWatch` stamps the arrival on its own clock, which is
	 * the clock `MoveExecutor.now()` and the settle window are measured against. The page's wall
	 * clock is not comparable with it, and an unread field that looks comparable is a trap.
	 */
	| { kind: "boardRect"; rect: Rect }
	| { kind: "moveObserved"; san: string; ply: number; byMe: boolean; atMs: number }
	/** Task 18: reply to `observeMove` — `ok` once the board/move list shows the move. */
	| { kind: "observeMoveResult"; id: string; ok: boolean; reason?: string }
	/**
	 * Reply to `cursorProbe` (the canonical §5.5 `cursor-probe` path, Task 21): the last
	 * trusted pointer position from the MAIN-world bridge closure, else the ISOLATED tracker.
	 */
	| {
			kind: "cursorProbeResult";
			id: string;
			position: { x: number; y: number; t: number; real: true } | null;
	  }
	/** Task 18: reply to `geometry`. */
	| ({ kind: "geometryResult"; id: string } & BoardGeometryReply)
	/**
	 * Task 18: reply to `boardCheck` — the colour-aware occupancy of exactly the squares asked
	 * (a square the adapter cannot classify is left out; the executor then dispatches nothing).
	 */
	| { kind: "boardCheckResult"; id: string; occupancy: Partial<Record<Square, Occupancy>> };

/** SW → content */
export type GamePortCommand =
	| { kind: "highlight"; from: Square; to: Square; style: HighlightStyle }
	| { kind: "clearHighlight" }
	| { kind: "arrow"; lines: Array<{ from: Square; to: Square; weight: number }> }
	| { kind: "keybinds"; keybinds: Keybinds }
	| { kind: "startNewGame" }
	| { kind: "speak"; text: string }
	/** Settings the content script acts on (`automation.highlightMoves`, §13.3 rule 4); default off until sent. */
	| { kind: "settings"; highlightMoves: boolean }
	/** Task 18: MutationObserver on board + move list; `ok` early, `false` if the piece snapped back. */
	| { kind: "observeMove"; id: string; expected: ExpectedMove; timeoutMs: number }
	/**
	 * Task 18: square/board/promotion rects on demand. `promotion` asks the adapter to wait
	 * for that picker (up to `timeoutMs`) and answer with its rect; `to` is the destination
	 * square the picker belongs to, which the adapter needs to place it.
	 */
	| { kind: "geometry"; id: string; promotion?: PromoPiece; to?: Square; timeoutMs?: number }
	/** Ask for the last known trusted pointer position; answered by `cursorProbeResult`. */
	| { kind: "cursorProbe"; id: string }
	/**
	 * Task 18: the executor's pre-dispatch position guard. Answer at once from the current
	 * board with `own` / `enemy` / `empty` for each square (relative to the side the hand
	 * plays) — colour-aware on purpose, so a capture is never mistaken for a landed move.
	 */
	| { kind: "boardCheck"; id: string; squares: Square[] }
	/**
	 * The pointer mirror (Fix D). `cursorTo` carries one point the hand has actually dispatched —
	 * viewport CSS px, the space `Input.dispatchMouseEvent` and `clientX/clientY` share, so the
	 * page program positions a `position: fixed` element with it and converts nothing — plus the
	 * left-button state at that point. One command per dispatched point (~45/s, measured): the
	 * content script relays it to the MAIN-world bridge, which is the only world allowed to insert
	 * the element (§13.3). `cursorHide` removes it.
	 */
	| { kind: "cursorTo"; x: number; y: number; down: boolean }
	| { kind: "cursorHide" };

/**
 * A slice of a net relayed by the SW (`handlers/engine/nnue-download.ts`).
 * `chrome.runtime` ports JSON-serialise their payloads (crbug.com/248548: no
 * structured clone), so an `ArrayBuffer` would arrive as `{}`; the raw bytes
 * (`LIMITS.nnueChunkBytes` per chunk) travel base64-encoded instead.
 */
export type NnueChunk =
	| { kind: "nnue-chunk"; name: string; index: number; total: number; bytes: string }
	| { kind: "nnue-chunk"; name: string; error: string };

/**
 * Inputs of one ChessMimic inference (Task 34): the token ids the service worker computed and
 * the raw rating/clocks — the offscreen host clamps the rating to the band it actually runs and
 * standardises with that band's scalers (`standardiseInputs`), so a substituted band never sees
 * another band's z-scores.
 */
export interface TimingInferenceInputs {
	/** Requested band (`CHESSMIMIC_BANDS`); the reply names the band that answered. */
	band: string;
	/** 12 UCI move tokens (left-padded). */
	moveTokens: number[];
	/** 78 FEN tokens. */
	fenTokens: number[];
	rating: number;
	playerClockS: number;
	opponentClockS: number;
	incrementS: number;
}

/** An on-demand model file relayed by the SW (`model-request` → `model-chunk`s), base64 like `NnueChunk`. */
export type ModelChunk =
	| { kind: "model-chunk"; name: string; index: number; total: number; bytes: string }
	| { kind: "model-chunk"; name: string; error: string };

/** offscreen → SW */
export type EnginePortMessage =
	| { kind: "line"; line: string }
	| { kind: "status"; status: EngineStatus }
	/** @deprecated superseded by `nnue-progress` (carries the net name); removed at integration. */
	| { kind: "nnue"; progress: number }
	/** Ask the SW to download a net that is neither bundled nor cached (Task 12). */
	| { kind: "nnue-request"; name: string }
	/** Download/reassembly progress in `[0, 1]` for `name`. */
	| { kind: "nnue-progress"; name: string; progress: number }
	/** Ask the SW to download a registered, non-bundled ChessMimic band (Task 34). */
	| { kind: "model-request"; name: string }
	/**
	 * Reply to a `timing` command: the 30 bucket probabilities, the band that answered and the
	 * inference wall time; `probs: null` + `error` when unavailable (the SW's head falls back to v1).
	 */
	| {
			kind: "timing-result";
			id: string;
			probs: number[] | null;
			band?: string;
			ms?: number;
			error?: string;
	  };

/** SW → offscreen */
export type EnginePortCommand =
	| { kind: "uci"; line: string }
	| { kind: "restart" }
	| { kind: "loadNnue"; names: string[] }
	/**
	 * Which build to run and how many threads the SW will ask for (first one boots the engine).
	 * `warmTiming` (Task 34) opts into pre-loading the ChessMimic default band: the offscreen
	 * document cannot know whether the SW's `TimingModel` selected the ChessMimic head, and
	 * warming costs ~200 ms of main-thread wasm work plus an 18 MB session, so it stays off
	 * unless the SW asks. Absent/false → no pre-warm.
	 */
	| { kind: "configure"; variant: EngineVariant; threads: number; warmTiming?: boolean }
	| NnueChunk
	| ModelChunk
	/** Timing-head inference request (Task 34); answered with `timing-result`. */
	| { kind: "timing"; id: string; inputs: TimingInferenceInputs }
	/** Load and warm the band's session ahead of the first move (Task 34); no reply. */
	| { kind: "timing-warm"; band: string };

// Task 26: log stream port (`PORT_NAMES.logStream`, Appendix H.2)

/** SW → panel: the ring backlog on connect, then one message per new entry. */
export type LogStreamMessage =
	| { kind: "backlog"; entries: LogEntry[] }
	| { kind: "entry"; entry: LogEntry };

/**
 * panel → SW: `hello` (first message on every connection) carries the level and asks for the
 * backlog; `setLevel` moves the source filter afterwards.
 */
export type LogStreamCommand =
	| { kind: "hello"; level: LogLevel }
	| { kind: "setLevel"; level: LogLevel };
