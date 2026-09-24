/**
 * The MAIN-world bridge as the ISOLATED world sees it: the `PageBridge` interface the adapter
 * consumes (Task 21's `PageBridgeClient` implements it; tests use a fake), the message kinds it
 * speaks, and the normalised state it reports.
 */

import type { Color, Square } from "@typedefs/game";

/**
 * The MAIN-world bridge as seen from the adapter (Task 21's `PageBridgeClient`).
 * `call` rejects on timeout or when the page side is absent.
 */
export interface PageBridge {
	call<T = unknown>(kind: string, payload?: unknown, timeoutMs?: number): Promise<T>;
	on(kind: string, cb: (payload: unknown) => void): () => void;
	isAvailable(): boolean;
	/**
	 * Fire-and-forget: send a command with no id and wait for nothing. Used by the pointer mirror
	 * (Fix D), whose stream is one command per dispatched point — a correlated `call` would
	 * allocate a pending entry and a timer per point for a reply nobody reads. Optional so a
	 * test bridge that only answers requests still satisfies the interface; `PageBridgeClient`
	 * always provides it.
	 */
	notify?(kind: string, payload?: unknown): void;
}

/** Bridge message kinds the adapter uses (Task 21 maps them onto the spoofed wire format). */
export const BRIDGE_KINDS = {
	// content → page
	getState: "getState",
	draw: "draw",
	clear: "clear",
	legalMoves: "legalMoves",
	// page → content
	ready: "ready",
	move: "move",
	load: "load",
	gameover: "gameover",
	state: "state",
	ply: "ply",
	/** Both directions: content asks for the last pointer position, the page answers (Task 21). */
	cursor: "cursor",
	/**
	 * Content → page, fire-and-forget (no reply): move the mirror of the hand's own pointer to
	 * `{x, y, down}`, and remove it again. Only the service worker knows what it dispatched, so
	 * these are the only bridge commands whose payload does not come from the page.
	 */
	cursorTo: "cursorTo",
	cursorHide: "cursorHide",
	/** Request/reply: open only the next virtual point through the native hit-test shield. */
	cursorPrepare: "cursorPrepare",
	/**
	 * Content → page: the board-effect batch for the move that just landed, plus the optional
	 * quality chip. Its own overlay element, drawn above the recommendation mark and cleared
	 * independently of it (rays: `Settings.automation.boardEffects`; chip:
	 * `automation.moveQualityChips` — each on its own since 2026-09-15).
	 */
	effects: "effects",
	effectsClear: "effectsClear",
	moveListRatings: "mlr",
} as const;

/** Normalised `getState` / `move` / `state` payload from the bridge. */
export interface BridgeState {
	fen?: string;
	turn?: Color | 1 | 2;
	playingAs?: Color | 1 | 2 | null;
	mode?: string;
	flipped?: boolean;
	lastMove?: { from: Square; to: Square; san?: string };
	result?: string | null;
	gameOver?: boolean;
	/** chess.com `timeControl.get()` / `timestamps.get()` as the site reports them (opaque). */
	timeControl?: unknown;
	timestamps?: unknown;
}

/** A bridge colour in either of the page's encodings (`1`/`2` or `"w"`/`"b"`); `null` otherwise. */
export function bridgeColor(v: Color | 1 | 2 | null | undefined): Color | null {
	if (v === 1 || v === "w") return "w";
	if (v === 2 || v === "b") return "b";
	return null;
}
