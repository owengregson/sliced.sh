/**
 * The `SiteAdapter` contract (§3.4, §3.4a, Appendix C §4) and the records it trades in: what the
 * content script asks of a site adapter, and what the adapter hands back. Implemented by
 * `AdapterBase` + `chesscom.ts`; nothing here has behaviour.
 */

import type {
	ExpectedMove,
	NewGameTargetResult,
	RematchAction,
	RematchTargetResult,
	ResignStep,
	ResignTargetResult,
} from "@core/constants/messages";
import type { Pt } from "@core/motor/types";
import type {
	ClockState,
	Color,
	GameResult,
	HighlightStyle,
	PageKind,
	PositionSnapshot,
	PromoPiece,
	Site,
	Square,
	TimeControl,
} from "@typedefs/game";
import type { PageBridge } from "./bridge-protocol";

export interface Point {
	x: number;
	y: number;
}

/** Structural viewport rectangle (a `DOMRect` satisfies it; tests build plain objects). */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface ClockReading extends ClockState {
	hasTenths: boolean;
}

export interface Opponent {
	isBot: boolean;
	name: string;
	ratingEstimate: number | null;
	/** The card's title ("FM", "GM", …), present only for a titled opponent (2026-09-13). */
	title?: string;
}

export interface FocusEdge {
	hasFocus: boolean;
	visibility: "visible" | "hidden";
	at: number;
}

export type FenSource = "bridge" | "replay" | "dom";

export interface PositionInfo {
	fen: string;
	/** DOM placement and SAN replay disagreed: castling/ep are heuristic (Appendix C §3). */
	approximate: boolean;
	source: FenSource;
}

/** What `onPositionChange` delivers: the port snapshot plus the accuracy flag. */
export interface AdapterPositionSnapshot extends PositionSnapshot {
	approximate: boolean;
}

export interface ArrowLine {
	from: Square;
	to: Square;
	weight: number;
}

/** How a draw is to be rendered, where the page offers a choice. */
export interface DrawOptions {
	/**
	 * Draw through the bridge's own SVG overlay instead of the site's native markings. The mark
	 * for a move the hand is about to play has to survive the whole action — the approach, every
	 * preview touch, the press, the drag, the release — and a native marking belongs to the site,
	 * which clears its user markings on a left press on the board (the owner's live report,
	 * 2026-09-10: "the move highlight disappears when the mouse starts its action"). Native
	 * markings stay the default for an ordinary recommendation mark: they are the site's own
	 * rendering and they need no DOM of ours.
	 */
	forceOverlay?: boolean;
}

export interface ProbeMatch {
	concern: string;
	index: number;
	selector: string;
}

export interface SelfCheckResult {
	name: string;
	ok: boolean;
	detail?: string;
}

export interface ProbeReport {
	site: Site;
	at: number;
	matched: ProbeMatch[];
	misses: string[];
	checks: SelfCheckResult[];
}

export type NewGameMode = "rematch" | "new";

export interface SiteAdapter {
	readonly site: Site;
	detectPageKind(): PageKind;
	/** V2 §13.6 */
	getOpponent(): Opponent | null;
	/** V2 §13.4: every `focus`/`blur`/`visibilitychange` edge (passive capture listeners). */
	onFocusEdge(cb: (edge: FocusEdge) => void): () => void;
	/** Board element found (and the bridge alive, if any). */
	isReady(): boolean;

	getFen(): string | null;
	getPositionInfo(): PositionInfo | null;
	/** DOM-only placement (self-check). */
	getPlacement(): string | null;
	getSideToMove(): Color | null;
	/** `null` when spectating / analysis. */
	getMyColor(): Color | null;
	getClock(side: Color): ClockReading | null;
	/**
	 * §4.3: the game's own time control, or `null` while the site has not answered (it answers
	 * only once the game has actually started). Everything the timing model does with the clock
	 * depends on this: without it every game conditions as `untimed`.
	 */
	getTimeControl(): TimeControl | null;
	/** SAN, main line only. */
	getMoveList(): string[];
	/** Plies played (main line) / current ply if browsing. */
	getPly(): number;
	isAtLivePosition(): boolean;
	isGameOver(): boolean;
	isMyTurn(): boolean;

	/** 8×8 playing area only. */
	getBoardRect(): Rect | null;
	/**
	 * §9.5: the board's viewport rect, whenever it moves or resizes by more than
	 * `EXECUTOR.boardMoveTolerancePx` (never the no-op reports). Passive reads only
	 * — a `ResizeObserver` plus the window's own `resize` / `scroll` (§13.3).
	 */
	onBoardRect(cb: (rect: Rect) => void): () => void;
	/** Black at the bottom. */
	isFlipped(): boolean;
	squareToPoint(sq: Square): Point | null;
	pointToSquare(p: Point): Square | null;
	squareRect(sq: Square): Rect | null;
	/** Where to click once the promotion dialog is open; `null` while it is closed. */
	getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null;

	/**
	 * The current position as one snapshot (the same reading `onPositionChange`
	 * would deliver), or `null` while the board is absent or unstable. Content
	 * boot uses it to feed the initial position of a game already in progress.
	 */
	readSnapshot(): AdapterPositionSnapshot | null;
	/** Debounced (`TIMINGS.adapterDebounceMs`), deduped; never fires mid-drag/animation/promotion. */
	onPositionChange(cb: (s: AdapterPositionSnapshot) => void): () => void;
	/** Page controls can make a board inactive without changing its position or URL. */
	onPageKindChange(cb: () => void): () => void;
	onGameStart(cb: () => void): () => void;
	onGameEnd(cb: (result: GameResult) => void): () => void;

	/** Draw the recommendation; only when asked — the adapter never draws on its own (§13.3). */
	highlight(from: Square, to: Square, style: HighlightStyle, options?: DrawOptions): void;
	arrows(lines: ArrowLine[], options?: DrawOptions): void;
	/** Resolves once the page side has answered (or the bridge call timed out / failed). */
	clearHighlights(): Promise<void>;

	/** Read or revalidate a site control; only the service worker performs native input. */
	newGameTarget(
		mode: NewGameMode,
		expectedGameId?: string | null,
		targetId?: string,
		point?: Pt
	): NewGameTargetResult;
	/**
	 * Read or revalidate the resign control of `step` (2026-09-12) — the same passive discipline
	 * as `newGameTarget`: a `targetId` + `point` must name the very element the rect was read
	 * from, under that point, or the answer is `not-ready`. Only the service worker clicks.
	 */
	resignTarget(step: ResignStep, targetId?: string, point?: Pt): ResignTargetResult;
	/**
	 * Read or revalidate the post-game rematch control of `action` (2026-09-13): our outgoing
	 * offer, the accept / decline of an incoming one, or the cancel of a pending offer — the same
	 * passive discipline as `newGameTarget`. Only the service worker clicks.
	 */
	rematchTarget(action: RematchAction, targetId?: string, point?: Pt): RematchTargetResult;
	/** Whether the opponent's own rematch offer is showing (the incoming panel with its Accept). */
	incomingRematch(): boolean;
	/** True once the piece lands on `expected.to` (confirmed by the move list), false if it snaps back. */
	observeMove(expected: ExpectedMove, timeoutMs: number): Promise<boolean>;
	probe(): ProbeReport;
	destroy(): void;
}

export interface AdapterOptions {
	document?: Document;
	window?: Window;
	bridge?: PageBridge;
	theme?: "dark" | "light";
}

/** One evaluation of the page, as the site adapter reads it (`null` = unstable, retry later). */
export interface AdapterReading {
	/** Dedupe key: placement + side to move. */
	key: string;
	snapshot: AdapterPositionSnapshot;
	gameOver: GameResult | null;
	/**
	 * Identity of the game: the URL game id when the page has one, otherwise
	 * `<path>#<serial>` for a replaced/reset board or a confirmed restart after game end.
	 * Never changes as plies accumulate (`gameIdentity()`).
	 */
	gameKey: string;
}

/** Progress of one `observeMove` watch, as the site adapter sees the board. */
export interface MoveWatch {
	placement: string | null;
	/** False when the placement was reconstructed from the same move list under verification. */
	independentPlacement?: boolean;
	moveCount: number;
	lastMoveSquares: Square[];
	/** Authoritative bridge/replay position; never a heuristic DOM reconstruction. */
	fen?: string;
	/** Complete SAN history through the currently displayed position. */
	history?: readonly string[];
}
