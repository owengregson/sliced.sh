/**
 * Game-domain types shared across contexts (§3.3, §4.3, Appendix C §4).
 * Task 3 extends this file; later tasks import these names.
 */

import type { EvalLine } from "@typedefs/engine";
import type { TimingPlan } from "@typedefs/timing";

export type Site = "chesscom" | "lichess";
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
	outcome: "executed" | "skipped" | "paused" | "aborted" | "failed";
	reason?: string;
	tier: "drag" | "click";
	attempts: number;
	endPoint: { x: number; y: number };
	elapsedMs: number;
	timeline: Array<{ phase: string; startMs: number; endMs: number }>;
	error?: string;
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
}
