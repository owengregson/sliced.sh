/** The board, the clocks and the game as the content script reports them (§4.3). */

/** The one supported site. Kept as a named type so snapshots stay self-describing. */
export type Site = "chesscom";
export type PageKind =
	| "live-game"
	| "live-spectate"
	| "live-postgame"
	| "live-lobby"
	| "vs-computer"
	| "daily"
	| "analysis"
	| "puzzles"
	| "other";
export type Color = "w" | "b";
export type Square =
	`${"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"}${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export type PromoPiece = "q" | "r" | "b" | "n";
export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";
export type HighlightStyle = "squares" | "arrows" | "both";

export interface ClockState {
	ms: number;
	running: boolean;
}
export interface TimeControl {
	baseMs: number;
	incMs: number;
}

/** Content → SW: the board state after each position change (§4.3). */
export interface PositionSnapshot {
	site: Site;
	gameId: string;
	fen: string;
	ply: number;
	sideToMove: Color;
	myColor: Color | null;
	lastMove?: { from: Square; to: Square; san: string };
	/** Complete SAN list through this position, validated by the session before use. */
	moveHistory?: string[];
	/**
	 * The adapter reconstructed this FEN from the DOM rather than reading it from the page's own game
	 * object (Appendix C §3's third source): the placement is real but the move counters, castling and
	 * en-passant are heuristic — `fullmove` is `Math.floor(ply / 2) + 1`, derived from the move-list
	 * ply.
	 *
	 * Absent means **not stated**, which is not the same as "exact": anything that draws a conclusion
	 * from a counter rather than from the placement has to consult this first, and a §13.4 permission
	 * treats anything but an explicit `false` as untrusted (`GameSession.isGameFirstMove`). The real
	 * adapter always states it (`AdapterPositionSnapshot` requires it), so a producer that omits it is
	 * a test fixture or a future one — either way it gets the safe answer rather than the permissive
	 * one.
	 */
	approximate?: boolean;
	clocks: { w: ClockState; b: ClockState };
	timeControl?: TimeControl;
	capturedAt: number;
}

/** Content → SW on `gameStarted`. */
export interface GameMeta {
	gameId: string;
	site: Site;
	pageKind: PageKind;
	myColor: Color | null;
	timeControl?: TimeControl;
	startedAt: number;
	/**
	 * The tab is on the exact `/play/online` queue screen (`isLobbyPath`). Sent only when true.
	 * The lobby's board reports itself as a live game, so this is the one URL fact the session's
	 * lobby hold cannot derive from the page kind (`src/service/game-session/lobby.ts`).
	 */
	lobby?: boolean;
}
