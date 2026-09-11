/**
 * Game-domain types shared across contexts (§3.3, §4.3, Appendix C §4).
 * Task 3 extends this file; later tasks import these names.
 */

import type { EvalLine } from "@typedefs/engine";
import type { TimingPlan } from "@typedefs/timing";

/** The one supported site. Kept as a named type so snapshots stay self-describing. */
export type Site = "chesscom";
export type PageKind =
	| "live-game"
	| "live-spectate"
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
}

/** GameSession states incl. the `live` sub-states (§3.3). */
export type GameSessionState =
	| "idle"
	| "waiting-for-game"
	| "live:opponent-turn"
	| "live:my-turn:analysing"
	| "live:my-turn:recommended"
	| "live:my-turn:executing"
	| "game-over";

/** Result of one virtual-hand execution (Task 18 shape). */
export interface ExecutionResult {
	ok: boolean;
	/**
	 * `dispatched` (Fix F) is a **premove gesture the hand completed during the opponent's turn**.
	 * That is *all* it claims: the drag went out. Whether chess.com kept it as a premove, snapped
	 * the piece back or read it as a selection is not observable from here — nothing in the
	 * executor can see it — so the word is `dispatched` rather than `queued` or `executed`, and the
	 * next position is the only thing that decides which it was. `ok` is true because the hand did
	 * its work; a premove must never be reported as a move that landed.
	 */
	outcome: "executed" | "dispatched" | "skipped" | "paused" | "aborted" | "failed";
	reason?: string;
	/**
	 * How the move was committed. Every committed move is a drag — click-to-move was removed
	 * (the owner's live-game report): the field stays because the panel's Last-action row and
	 * the timing log name the input method, and a second inhabitant would have to be added back
	 * deliberately rather than by accident.
	 */
	tier: "drag";
	attempts: number;
	endPoint: { x: number; y: number };
	elapsedMs: number;
	timeline: Array<{ phase: string; startMs: number; endMs: number }>;
	error?: string;
	/** Task 24: epoch ms the execution finished — identifies one result across snapshots (stamped by the executor). */
	at?: number;
	/** SAN of the move this result belongs to (Task 26's Last-action row). */
	san?: string;
	/** §13.2 `PointerOffset`: pointer path length the hand dispatched during this execution, px. */
	pointerOffsetPx?: number;
	/**
	 * §13.2 `DidSelectMultiplePieces`: the squares the hand *pressed* other than the committed
	 * from-square — the preview selections (§9.3a) and any deselect click. With the committed
	 * press these are the distinct pieces the page saw selected in this move window.
	 */
	previewedSquares?: Square[];
	/** The committed press was dispatched — even a skipped/aborted attempt may have landed the move. */
	pressed?: boolean;
	/**
	 * *Any* press was dispatched in this attempt, the §9.3a preview selections included. A preview
	 * press is never `pressed` (it is not the committed press), but it is a real `mousedown` on a
	 * real square: if the window ends between it and its release — a reflow, a focus skip mid-drag —
	 * the page can have seen `down` on one square and `up` on another, which is a submitted move. So
	 * this is the flag that decides whether the board must be looked at before reporting the outcome.
	 */
	pressedAny?: boolean;
}

export interface GameSessionView {
	state: GameSessionState;
	gameId: string | null;
	site: Site | null;
	pageKind: PageKind;
	myColor: Color | null;
	sideToMove: Color | null;
	ply: number;
	clocks: PositionSnapshot["clocks"] | null;
	timeControl?: TimeControl;
	hand: "resting" | "exploring" | "moving" | "paused" | "detached";
	lastExecution?: ExecutionResult;
}

export interface ChosenMove {
	uci: string;
	san: string;
	from: Square;
	to: Square;
	promotion?: PromoPiece;
	source: "engine-elo" | "sampled" | "blunder" | "mate" | "book" | "premove";
	rankInLines: number;
	cpLoss: number;
	rationale: string[];
}

export interface Recommendation {
	chosen: ChosenMove;
	lines: EvalLine[];
	eval: EvalLine["score"];
	wdl?: [number, number, number];
	depth: number;
	nps: number;
	plan: TimingPlan;
	computedAt: number;
	fen: string;
}

/** `LOCAL_KEYS.sessionStats` (games, moves, avgThinkMs). */
export interface SessionStats {
	games: number;
	moves: number;
	avgThinkMs: number;
	/** Task 24 (§13.6 session strip): running top-1 agreement, 0–100 (absent until the first move). */
	top1Pct?: number;
	/** Running average centipawn loss (absent until the first move). */
	acpl?: number;
	/** Consecutive finished games outside the Appendix E §1.6 band for the derived target. */
	outOfBandStreak?: number;
	/**
	 * Moves the §13.6 quality pair was computed over — the ones that carry an engine evaluation.
	 * A premove is decided before the position exists and a book move outside the engine's lines
	 * has no rank or loss, so both are excluded from `top1Pct` / `acpl` (they would otherwise
	 * score as zero-loss non-top-1 moves and drag the pair down in exactly the speed classes
	 * §7.4 premoves in). `moves` still counts every move played.
	 */
	scoredMoves?: number;
}
