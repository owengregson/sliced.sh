/**
 * Game-domain types shared across contexts (§3.3, §4.3, Appendix C §4).
 * Task 3 extends this file; later tasks import these names.
 */

import type { MaiaSize } from "@core/constants/maia";
import type { EvalLine } from "@typedefs/engine";
import type { TimingPlan } from "@typedefs/timing";

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
	 * How the move was committed: a drag, or — since the owner's 2026-09-11 reversal, as
	 * `Settings.execution.inputMode` — a click-click. The panel's Last-action row and the timing log
	 * name it.
	 */
	tier: "drag" | "click";
	attempts: number;
	endPoint: { x: number; y: number };
	elapsedMs: number;
	/** Epoch start of the hand window; elapsedMs retains the physical hand-window duration. */
	startedAt?: number;
	/** Actual drop/promotion submission, before post-drop rest and verification. */
	submittedAt?: number;
	/** Manual acceleration or a retry must not train the natural timing feedback. */
	paceOverride?: boolean;
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
	/**
	 * Right-button drags the hand dispatched in this execution — the arrows of a line preview
	 * (`LINE_PREVIEW`). Present only when at least one went out. Not a press in the §13.2 sense:
	 * an arrow selects nothing and can submit nothing, so it is neither in `previewedSquares` nor
	 * behind `pressedAny`.
	 */
	annotations?: number;
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
	/** Epoch time at which the site's remaining clock values were captured. */
	clocksAt?: number;
	/** An armed move may be fast-forwarded through preparation, until its committed mouse-down. */
	canPlayNow?: boolean;
	/**
	 * Pending automatic matchmaking. dueAt is the next attempt's epoch time — during `rematch`
	 * (2026-09-13: a rematch offered to, or accepted from, a titled opponent) the moment the
	 * ordinary queue click follows if the next game has not started by then.
	 */
	autoQueue?: {
		dueAt: number;
		attempts: number;
		status: "waiting" | "break" | "retrying" | "searching" | "rematch";
	};
	/** Latest analysis for the current position, including opponent-turn pondering. Side-to-move POV. */
	evaluation?: {
		fen: string;
		eval: EvalLine["score"];
		wdl?: [number, number, number];
	};
	timeControl?: TimeControl;
	/**
	 * The lobby hold is on (present only when true): the tab is on `/play/online` with a board
	 * whose clocks have not moved, so no game has been queued yet and the hand stays off the mouse.
	 */
	lobbyHold?: boolean;
	hand: "resting" | "exploring" | "moving" | "paused" | "detached";
	lastExecution?: ExecutionResult;
}

export interface ChosenMove {
	uci: string;
	san: string;
	from: Square;
	to: Square;
	promotion?: PromoPiece;
	/** `maia` (2026-09-11): drawn from the Maia-3 human policy over the engine's scored lines. */
	source:
		| "engine-elo"
		| "sampled"
		| "blunder"
		| "mate"
		| "book"
		| "premove"
		| "maia"
		/** 2026-09-23: the endgame tablebase's move for a ≤ 7-man position (`@core/tablebase`). */
		| "tablebase";
	rankInLines: number;
	/** Raw searched centipawn loss, omitted when the scores are not comparable. */
	cpLoss?: number;
	quality?: {
		kind: "search" | "book";
		eligible: boolean;
		reason?:
			| "forced"
			| "mate"
			| "bound"
			| "shallow"
			| "unknown"
			| "depth-mismatch"
			| "incomplete"
			| "opponent-rush"
			| "book"
			| "tablebase";
		depth: number;
		candidates: number;
	};
	rationale: string[];
	/** `source === "maia"`: the model's probability of this move (raw, before tempering). */
	maiaProb?: number;
	/** Fidelity meters of the Maia draw that produced this move (2026-09-13). */
	maiaMeters?: MaiaMeters;
}

/**
 * How much of the move was Maia's and how much was ours (2026-09-13, §3.2 of
 * `docs/research/human-move-selection-ideas-2026-09-13.md`). Every field is per move, computed
 * inside the selector from numbers it already had; nothing here calibrates the model.
 */
export interface MaiaMeters {
	/** The rating the query and the rails judged at (after pressure, slider and context terms). */
	selfElo: number;
	/** Normalised entropy of Maia's legal-move distribution, `H / log(#legal)` in [0, 1]. */
	entropy: number;
	/** Σ p over the scored candidates the rails excluded. */
	railedMass: number;
	/** Σ p over Maia's legal moves the engine never scored (before the rails). */
	unscoredMass: number;
	/** KL(final draw weights ‖ Maia) over the drawn set — 0 when the wrapper changed nothing. */
	klFromMaia: number;
	/** Maia's 1-based rank of the pick among the survivors (`0` = not a Maia pick). */
	rank: number;
	/** Survivors the draw was over. */
	survivors: number;
	/** Generate-and-verify (H3): candidates drawn, or absent when the plain draw ran. */
	candidates?: number;
	/** H3: the depth the candidates were verified at. */
	verifyDepth?: number;
}

export interface Recommendation {
	chosen: ChosenMove;
	lines: EvalLine[];
	eval: EvalLine["score"];
	wdl?: [number, number, number];
	/**
	 * The Maia-3 policy's answer for this position when it was queried and arrived in budget —
	 * the size that answered, its side-to-move `(loss, draw, win)` and the host's inference wall
	 * time. Present whether or not the selector used it (`chosen.source === "maia"` says that);
	 * `wdl` above stays the engine's.
	 */
	maia?: {
		size: MaiaSize;
		wdl: [number, number, number];
		ms?: number;
		/** The model's probability of the chosen move when the selector drew from it (`chosen.maiaProb`). */
		p?: number;
		/** Positions the query carried (1 … `MAIA_INPUT.history`); `1` = the degenerate no-history case. */
		historyPlies?: number;
		/** The `selfElo` the query was issued at. */
		selfElo?: number;
		/** `chosen.maiaMeters` when the selector drew from the model. */
		meters?: MaiaMeters;
	};
	depth: number;
	nps: number;
	plan: TimingPlan;
	computedAt: number;
	fen: string;
}

export interface SessionQualitySample {
	scoredMoves: number;
	top1Pct: number;
	/** Mean loss between comparable root search scores, not independent post-game ACPL. */
	acpl: number;
	/** Welford sum of squared deviations for the root-loss sample. */
	lossM2: number;
}

export interface SessionQualityCohort extends SessionQualitySample {
	key: string;
	targetElo: number;
	eligibleGames: number;
	outOfBandStreak: number;
}

export interface SessionQualityGame extends SessionQualitySample {
	gameId: string;
	cohortKey: string;
	targetElo: number;
}

/** Overall activity counts plus versioned, comparable search-quality samples. */
export interface SessionStats {
	games: number;
	moves: number;
	avgThinkMs: number;
	/** Versioned full-turn observations; legacy hand-only averages are not comparable. */
	timingVersion?: number;
	timingSamples?: number;
	/** Bounded receipt history, saved atomically with the game totals for restart-safe deduplication. */
	finishedGameIds?: string[];
	/** Task 24 (§13.6 session strip): running top-1 agreement, 0–100 (absent until the first move). */
	top1Pct?: number;
	/** Running average centipawn loss (absent until the first move). */
	acpl?: number;
	/** Legacy pooled warning; discarded during quality migration. Current warnings live per cohort. */
	outOfBandStreak?: number;
	/**
	 * Moves the §13.6 quality pair was computed over — the ones that carry an engine evaluation.
	 * A premove is decided before the position exists and a book move outside the engine's lines
	 * has no rank or loss, so both are excluded from `top1Pct` / `acpl` (they would otherwise
	 * score as zero-loss non-top-1 moves and drag the pair down in exactly the speed classes
	 * §7.4 premoves in). `moves` still counts every move played.
	 */
	scoredMoves?: number;
	lossM2?: number;
	/** Older quality had no source/target provenance and is not reusable. */
	qualityVersion?: number;
	qualityCohorts?: SessionQualityCohort[];
	qualityGames?: SessionQualityGame[];
}
