/**
 * `SiteAdapter` — the ISOLATED-world board adapter contract (§3.4, §3.4a,
 * Appendix C §4) implemented by `chesscom.ts`, plus the `PageBridge` the
 * adapter consumes for MAIN-world state and drawing (Task 21 implements
 * `PageBridgeClient`; tests use a fake).
 *
 * `AdapterBase` holds the board-watching runtime that is independent of any
 * markup — debounced re-evaluation, observer bookkeeping, the bridge-state
 * cache, `observeMove`, game identity, probe reporting — so `chesscom.ts`
 * contains only the DOM/bridge reading. It is the seam the adapter tests
 * drive. No adapter method reads or writes page storage (§13.3).
 */

import type { UciParts } from "@core/chess/san";
import { EXECUTOR } from "@core/constants/cdp";
import { TIME_CONTROL, TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { rectShiftPx } from "@core/motor/geometry";
import { TOKENS } from "@design/tokens.generated";
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
import { pieceAt } from "./dom-fen";
import { pointToSquare as pointToSquareGeom, squareRect as squareRectGeom } from "./geometry";
import { checkGeometry } from "./self-check";

const MOVE_CONFIRM_MS = TIMINGS.adapterMoveConfirmMs;
const BRIDGE_CALL_TIMEOUT_MS = TIMINGS.adapterBridgeTimeoutMs;

interface HighlightColors {
	hlFrom: string;
	hlTo: string;
	hlArrow: string;
	hlArrow2: string;
	hlArrow3: string;
}

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
	onGameStart(cb: () => void): () => void;
	onGameEnd(cb: (result: GameResult) => void): () => void;

	/** Draw the recommendation; only when asked — the adapter never draws on its own (§13.3). */
	highlight(from: Square, to: Square, style: HighlightStyle): void;
	arrows(lines: ArrowLine[]): void;
	/** Resolves once the page side has answered (or the bridge call timed out / failed). */
	clearHighlights(): Promise<void>;

	/** Click the site's own new-game / rematch control; whether one was found. */
	tryStartNewGame(mode: NewGameMode): boolean;
	/** True once the piece lands on `expected.to` (confirmed by the move list), false if it snaps back. */
	observeMove(expected: UciParts, timeoutMs: number): Promise<boolean>;
	probe(): ProbeReport;
	destroy(): void;
}

/**
 * The MAIN-world bridge as seen from the adapter (Task 21's `PageBridgeClient`).
 * `call` rejects on timeout or when the page side is absent.
 */
export interface PageBridge {
	call<T = unknown>(kind: string, payload?: unknown, timeoutMs?: number): Promise<T>;
	on(kind: string, cb: (payload: unknown) => void): () => void;
	isAvailable(): boolean;
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
} as const;

/** Normalised `getState` / `move` / `state` payload from the bridge. */
export interface BridgeState {
	fen?: string;
	turn?: Color | 1 | 2;
	playingAs?: Color | 1 | 2 | null;
	mode?: string;
	flipped?: boolean;
	lastMove?: { from: Square; to: Square; san?: string };
	result?: string;
	gameOver?: boolean;
	/** chess.com `timeControl.get()` / `timestamps.get()` as the site reports them (opaque). */
	timeControl?: unknown;
	timestamps?: unknown;
}

export interface AdapterOptions {
	document?: Document;
	window?: Window;
	bridge?: PageBridge;
	theme?: "dark" | "light";
}

/** Trailing-edge debounce on the global timers; `cancel()` drops a pending call. */
export function debounced(fn: () => void, ms: number): { trigger(): void; cancel(): void } {
	let handle: ReturnType<typeof setTimeout> | null = null;
	return {
		trigger(): void {
			if (handle !== null) clearTimeout(handle);
			handle = setTimeout(() => {
				handle = null;
				fn();
			}, ms);
		},
		cancel(): void {
			if (handle !== null) clearTimeout(handle);
			handle = null;
		},
	};
}

/**
 * Passive capture listeners for `window` focus/blur and `document`
 * visibilitychange; every edge is reported (V2 §13.4). Returns the remover.
 */
export function installFocusEdges(
	win: Window,
	doc: Document,
	cb: (edge: FocusEdge) => void
): () => void {
	const opts: AddEventListenerOptions = { capture: true, passive: true };
	const report = (): void => {
		cb({
			hasFocus: typeof doc.hasFocus === "function" ? doc.hasFocus() : true,
			visibility: doc.visibilityState === "hidden" ? "hidden" : "visible",
			at: Date.now(),
		});
	};
	win.addEventListener("focus", report, opts);
	win.addEventListener("blur", report, opts);
	doc.addEventListener("visibilitychange", report, opts);
	return () => {
		win.removeEventListener("focus", report, opts);
		win.removeEventListener("blur", report, opts);
		doc.removeEventListener("visibilitychange", report, opts);
	};
}

export function toRect(r: {
	x?: number;
	y?: number;
	left?: number;
	top?: number;
	width: number;
	height: number;
}): Rect {
	const x = r.x ?? r.left ?? 0;
	const y = r.y ?? r.top ?? 0;
	return {
		x,
		y,
		width: r.width,
		height: r.height,
		left: x,
		top: y,
		right: x + r.width,
		bottom: y + r.height,
	};
}

export function bridgeColor(v: Color | 1 | 2 | null | undefined): Color | null {
	if (v === 1 || v === "w") return "w";
	if (v === 2 || v === "b") return "b";
	return null;
}

/** One evaluation of the page, as the site adapter reads it (`null` = unstable, retry later). */
export interface AdapterReading {
	/** Dedupe key: placement + side to move. */
	key: string;
	snapshot: AdapterPositionSnapshot;
	gameOver: GameResult | null;
	/**
	 * Identity of the game: the URL game id when the page has one, otherwise
	 * `<path>#<serial>` where the serial advances only when a fresh board appears
	 * (board element replaced, or the ply count reset after ≥ 2 plies). Never
	 * changes as plies accumulate (`gameIdentity()`).
	 */
	gameKey: string;
}

/** Progress of one `observeMove` watch, as the site adapter sees the board. */
export interface MoveWatch {
	placement: string | null;
	moveCount: number;
	lastMoveSquares: Square[];
}

/** Shared adapter runtime: listeners, debounced evaluation, bridge cache, highlight keys, self-check timer. */
export abstract class AdapterBase implements SiteAdapter {
	abstract readonly site: Site;
	protected readonly doc: Document;
	protected readonly win: Window;
	/** The bridge object is kept even before the page side is ready; `bridgeReady()` gates every use. */
	protected readonly bridge: PageBridge | null;
	protected readonly theme: "dark" | "light";
	protected bridgeState: BridgeState | null = null;
	protected highlightKeys: string[] = [];
	private readonly positionCbs = new Set<(s: AdapterPositionSnapshot) => void>();
	private readonly startCbs = new Set<() => void>();
	private readonly endCbs = new Set<(r: GameResult) => void>();
	private readonly disposers: Array<() => void> = [];
	private readonly observers: MutationObserver[] = [];
	private readonly observerDisposers: Array<() => void> = [];
	private readonly pending: { trigger(): void; cancel(): void };
	private lastKey: string | null = null;
	/**
	 * `myColor` of the last reading delivered. The colour of a live game arrives *after* its first
	 * reading — the MAIN-world bridge answers `getPlayingAs()` a moment after the board appears, and
	 * before that the live page carries no colour evidence at all — while the position itself has
	 * not moved, so the dedupe key is identical and the session would hold a colourless ply for
	 * ever (owner's live test, 2026-09-09). Learning the colour is therefore a change worth
	 * delivering in its own right. Only `null → known` on the game already being followed counts:
	 * losing it (the page became an analysis board) is not a new position, and regaining it on a
	 * different board is that board's own game start.
	 */
	private lastColor: Color | null = null;
	/**
	 * The time control of the last reading delivered, for the same reason as `lastColor`: the site
	 * answers `timeControl.get()` only once the game has actually *started* — a game "not yet
	 * started" answers `null` while its clocks already read `10:00` (owner's capture, 2026-09-09)
	 * — and by then the position has not moved, so the dedupe key is identical and the session
	 * would plan the whole first move as `untimed`: classical motor profile, no premoves, a 7.5 s
	 * think and every clock-pressure term bypassed. Learning it is a change worth delivering.
	 */
	private lastTimeControl: TimeControl | null = null;
	/** Bridge re-asks spent on a time control this game has not been told (`TIME_CONTROL.maxProbes`). */
	private timeControlProbes = 0;
	private timeControlTimer: ReturnType<typeof setTimeout> | null = null;
	private lastGameKey: string | null = null;
	private lastGameOver = false;
	private lastProbeSignature: string | null = null;
	private gameSerial = 0;
	private gameBoard: Element | null = null;
	private gamePly = -1;
	private selfCheckTimer: ReturnType<typeof setInterval> | null = null;
	private destroyed = false;
	private primed = false;
	private readonly boardRectCbs = new Set<(rect: Rect) => void>();
	/** The board-rect watch is installed on the first `onBoardRect` subscription, once. */
	private rectWatch = false;
	private rectObserver: ResizeObserver | null = null;
	private rectTarget: Element | null = null;
	private lastBoardRect: Rect | null = null;

	constructor(options: AdapterOptions, debounceMs: number, selfCheckMs: number) {
		this.doc = options.document ?? document;
		this.win = options.window ?? window;
		this.bridge = options.bridge ?? null;
		this.theme = options.theme ?? "dark";
		this.pending = debounced(() => this.evaluate(), debounceMs);
		this.selfCheckTimer = setInterval(() => {
			if (!this.destroyed) this.probe();
		}, selfCheckMs);
	}

	/** Site adapters call this at the end of their constructor (observers need the subclass fields). */
	protected start(): void {
		this.reinstallObservers();
		this.wireBridge();
		this.prime();
		this.probe();
	}

	// ---- abstract site readers -------------------------------------------------

	/** Register every MutationObserver / listener through `observe` / `addObserverDisposer`. */
	protected abstract installObservers(): void;
	/** `null` while the board is unstable (dragging, animating, promotion dialog open). */
	protected abstract read(): AdapterReading | null;
	protected abstract watchMove(): MoveWatch;
	protected abstract drawPayload(
		highlights: Array<{ square: Square; color: string }>,
		arrows: Array<{ from: Square; to: Square; color: string }>
	): unknown;
	protected abstract clearPayload(): unknown;
	/** The 8×8 board element (`wc-chess-board`). */
	protected abstract boardElement(): Element | null;
	/** Whether the page renders a move list at all (parity is meaningless without one). */
	protected abstract hasMoveList(): boolean;
	/** Game id from the URL, or `null` when the page has none (chess.com `/play/computer`). */
	protected abstract urlGameId(): string | null;
	abstract detectPageKind(): PageKind;
	abstract getOpponent(): Opponent | null;
	abstract isReady(): boolean;
	abstract getPositionInfo(): PositionInfo | null;
	abstract getPlacement(): string | null;
	abstract getSideToMove(): Color | null;
	abstract getMyColor(): Color | null;
	abstract getClock(side: Color): ClockReading | null;
	abstract getTimeControl(): TimeControl | null;
	abstract getMoveList(): string[];
	abstract getPly(): number;
	abstract isAtLivePosition(): boolean;
	abstract isGameOver(): boolean;
	abstract getBoardRect(): Rect | null;
	abstract isFlipped(): boolean;
	abstract getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null;
	abstract tryStartNewGame(mode: NewGameMode): boolean;
	abstract probe(): ProbeReport;

	// ---- shared behaviour --------------------------------------------------------

	getFen(): string | null {
		return this.getPositionInfo()?.fen ?? null;
	}

	isMyTurn(): boolean {
		const me = this.getMyColor();
		return me !== null && me === this.getSideToMove() && !this.isGameOver();
	}

	squareToPoint(sq: Square): Point | null {
		const r = this.squareRect(sq);
		return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
	}

	pointToSquare(p: Point): Square | null {
		const rect = this.getBoardRect();
		return rect ? pointToSquareGeom(p, rect, this.isFlipped()) : null;
	}

	squareRect(sq: Square): Rect | null {
		const rect = this.getBoardRect();
		return rect && rect.width > 0 ? squareRectGeom(sq, rect, this.isFlipped()) : null;
	}

	onFocusEdge(cb: (edge: FocusEdge) => void): () => void {
		const off = installFocusEdges(this.win, this.doc, cb);
		this.disposers.push(off);
		return off;
	}

	/**
	 * §9.5: report the board's rect whenever the page moves or resizes it. The hand plans a whole
	 * drag from one geometry read, so a reflow mid-drag — which is exactly what the debugger's
	 * infobar causes when the user arms during a game (owner's live test, 2026-09-09) — leaves every
	 * remaining path point in the old coordinate space and drops the piece on the wrong square.
	 *
	 * A `ResizeObserver` on the board catches the board being resized, one on the document element
	 * catches the viewport changing height (the infobar) even when the board keeps its size, and the
	 * window's `resize` / `scroll` catch the rest — the rect is viewport-relative, so a scroll moves
	 * it. All passive reads: nothing is dispatched, stored or defined on the page (§13.3).
	 */
	onBoardRect(cb: (rect: Rect) => void): () => void {
		this.boardRectCbs.add(cb);
		this.installRectWatch();
		return () => {
			this.boardRectCbs.delete(cb);
		};
	}

	readSnapshot(): AdapterPositionSnapshot | null {
		if (this.destroyed) return null;
		return this.read()?.snapshot ?? null;
	}

	onPositionChange(cb: (s: AdapterPositionSnapshot) => void): () => void {
		this.positionCbs.add(cb);
		return () => this.positionCbs.delete(cb);
	}

	onGameStart(cb: () => void): () => void {
		this.startCbs.add(cb);
		return () => this.startCbs.delete(cb);
	}

	onGameEnd(cb: (result: GameResult) => void): () => void {
		this.endCbs.add(cb);
		return () => this.endCbs.delete(cb);
	}

	highlight(from: Square, to: Square, style: HighlightStyle): void {
		const colors = this.colors();
		const highlights =
			style === "arrows"
				? []
				: [
						{ square: from, color: colors.hlFrom },
						{ square: to, color: colors.hlTo },
					];
		const arrows = style === "squares" ? [] : [{ from, to, color: colors.hlArrow }];
		this.draw(highlights, arrows);
	}

	arrows(lines: ArrowLine[]): void {
		const colors = this.colors();
		const palette = [colors.hlArrow, colors.hlArrow2, colors.hlArrow3];
		const ordered = [...lines].sort((a, b) => b.weight - a.weight);
		this.draw(
			[],
			ordered.map((l, i) => ({
				from: l.from,
				to: l.to,
				color: palette[Math.min(i, palette.length - 1)] ?? colors.hlArrow,
			}))
		);
	}

	clearHighlights(): Promise<void> {
		const bridge = this.readyBridge();
		if (!bridge) return Promise.resolve();
		const payload = this.clearPayload();
		this.highlightKeys = [];
		return bridge
			.call(BRIDGE_KINDS.clear, payload, BRIDGE_CALL_TIMEOUT_MS)
			.then(() => undefined)
			.catch((e: unknown) => {
				log.debug("adapter.clear failed", this.site, e);
			});
	}

	observeMove(expected: UciParts, timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const initial = this.watchMove();
			const mover = initial.placement ? pieceAt(initial.placement, expected.from) : null;
			if (!mover) {
				resolve(false);
				return;
			}
			const wantAtDest = expected.promotion
				? mover === mover.toUpperCase()
					? expected.promotion.toUpperCase()
					: expected.promotion
				: mover;
			let landed = false;
			let done = false;
			let confirmTimer: ReturnType<typeof setTimeout> | null = null;
			const Observer = this.observerCtor();
			const observer = new Observer(() => check());
			const finish = (ok: boolean): void => {
				if (done) return;
				done = true;
				observer.disconnect();
				clearTimeout(timeout);
				if (confirmTimer !== null) clearTimeout(confirmTimer);
				resolve(ok);
			};
			const timeout = setTimeout(() => finish(landed), timeoutMs);
			const check = (): void => {
				if (done) return;
				const now = this.watchMove();
				if (!now.placement) return;
				const atFrom = pieceAt(now.placement, expected.from);
				const atTo = pieceAt(now.placement, expected.to);
				if (atTo === wantAtDest && atFrom === null) {
					const confirmed =
						now.moveCount > initial.moveCount ||
						(now.lastMoveSquares.includes(expected.from) && now.lastMoveSquares.includes(expected.to));
					if (confirmed) {
						finish(true);
						return;
					}
					if (!landed) {
						landed = true;
						confirmTimer = setTimeout(
							() => {
								const p = this.watchMove().placement;
								finish(p !== null && pieceAt(p, expected.to) === wantAtDest);
							},
							Math.min(MOVE_CONFIRM_MS, timeoutMs)
						);
					}
					return;
				}
				if (landed && atFrom === mover) finish(false); // snapped back
			};
			observer.observe(this.doc.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["class", "style"],
			});
			check();
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.pending.cancel();
		if (this.selfCheckTimer !== null) clearInterval(this.selfCheckTimer);
		this.selfCheckTimer = null;
		if (this.timeControlTimer !== null) clearTimeout(this.timeControlTimer);
		this.timeControlTimer = null;
		this.disconnectObservers();
		for (const d of this.disposers.splice(0)) d();
		this.positionCbs.clear();
		this.startCbs.clear();
		this.endCbs.clear();
		this.boardRectCbs.clear();
	}

	// ---- helpers for subclasses --------------------------------------------------

	protected observe(
		target: Node | null,
		init: MutationObserverInit,
		filter?: (records: MutationRecord[]) => boolean
	): void {
		if (!target) return;
		const Observer = this.observerCtor();
		const observer = new Observer((records: MutationRecord[]) => {
			if (filter && !filter(records)) return;
			this.schedule();
		});
		observer.observe(target, init);
		this.observers.push(observer);
	}

	/** Listener removers that belong to the current observer set (dropped on re-install). */
	protected addObserverDisposer(fn: () => void): void {
		this.observerDisposers.push(fn);
	}

	/** Disconnect every observer/listener from `installObservers` and install afresh (containers replaced). */
	protected reinstallObservers(): void {
		this.disconnectObservers();
		this.installObservers();
		this.retargetRectObserver();
	}

	private installRectWatch(): void {
		if (this.rectWatch || this.destroyed) return;
		this.rectWatch = true;
		const report = (): void => this.reportBoardRect();
		// `scroll` fires far more often than the board moves. It is coalesced on the next animation
		// frame rather than debounced on a timer: the report feeds the hand's mid-drag reflow guard,
		// so it must land within a frame of the page settling, not 40 ms later. `resize` — the
		// infobar's own signal — and the `ResizeObserver` (already frame-aligned) report at once.
		let frame: number | null = null;
		const raf = this.rafOf();
		const coalesced = (): void => {
			if (!raf) {
				report();
				return;
			}
			if (frame !== null) return;
			frame = raf(() => {
				frame = null;
				report();
			});
		};
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		this.win.addEventListener("resize", report, opts);
		this.win.addEventListener("scroll", coalesced, opts);
		this.disposers.push(() => {
			this.win.removeEventListener("resize", report, opts);
			this.win.removeEventListener("scroll", coalesced, opts);
			const cancel = this.win.cancelAnimationFrame?.bind(this.win);
			if (frame !== null && cancel) cancel(frame);
			frame = null;
		});
		const Observer = this.resizeObserverCtor();
		if (Observer) {
			const observer = new Observer(report);
			this.rectObserver = observer;
			this.disposers.push(() => {
				observer.disconnect();
				this.rectObserver = null;
				this.rectTarget = null;
			});
			this.retargetRectObserver();
		}
		// The baseline: the service worker needs one rect before it can tell a change from a first look.
		this.reportBoardRect();
	}

	/** Point the rect observer at the current board (and the document element) after a replacement. */
	private retargetRectObserver(): void {
		const observer = this.rectObserver;
		if (!observer) return;
		const board = this.boardElement();
		if (board !== null && board === this.rectTarget) return;
		observer.disconnect();
		this.rectTarget = board;
		if (board) observer.observe(board);
		// The infobar changes the viewport's height without necessarily resizing the board element.
		const root = this.doc.documentElement;
		if (root) observer.observe(root);
	}

	private reportBoardRect(): void {
		if (this.destroyed || this.boardRectCbs.size === 0) return;
		const rect = this.getBoardRect();
		if (!rect || !(rect.width > 0)) return;
		const last = this.lastBoardRect;
		// Only real movement: a `scroll` that moved nothing must not rearm the settle window the
		// executor waits on after an attach.
		if (last && rectShiftPx(last, rect) <= EXECUTOR.boardMoveTolerancePx) return;
		this.lastBoardRect = rect;
		for (const cb of [...this.boardRectCbs]) cb(rect);
	}

	/** The page's `requestAnimationFrame` (absent in a stripped test window). */
	private rafOf(): ((cb: () => void) => number) | null {
		const raf = this.win.requestAnimationFrame;
		return typeof raf === "function" ? (cb) => raf.call(this.win, cb) : null;
	}

	/** The page's `ResizeObserver` (absent in an old engine or a stripped test window). */
	private resizeObserverCtor(): typeof ResizeObserver | null {
		const w = this.win as unknown as { ResizeObserver?: typeof ResizeObserver };
		const ctor = w.ResizeObserver ?? (typeof ResizeObserver === "function" ? ResizeObserver : null);
		return typeof ctor === "function" ? ctor : null;
	}

	/** Does any added/removed element of `records` match (or contain) `selector`? */
	protected touches(records: MutationRecord[], selector: string): boolean {
		return records.some((r) =>
			[...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some((n) => {
				if (n.nodeType !== 1) return false;
				const el = n as Element;
				try {
					return el.matches(selector) || el.querySelector(selector) !== null;
				} catch {
					return false;
				}
			})
		);
	}

	/** Debounced re-evaluation (MutationObservers and bridge events call this). */
	protected schedule(): void {
		if (!this.destroyed) this.pending.trigger();
	}

	protected addDisposer(fn: () => void): void {
		this.disposers.push(fn);
	}

	protected colors(): HighlightColors {
		return TOKENS.color[this.theme];
	}

	/** The page's `MutationObserver` (the injected window in tests, the global in a content script). */
	private observerCtor(): typeof MutationObserver {
		const w = this.win as unknown as { MutationObserver?: typeof MutationObserver };
		return w.MutationObserver ?? MutationObserver;
	}

	/** The bridge, only once its page side has answered ready (consulted at every use). */
	protected readyBridge(): PageBridge | null {
		return this.bridge?.isAvailable() ? this.bridge : null;
	}

	protected bridgeFen(): string | null {
		return this.bridgeState?.fen ?? null;
	}

	/** Side to move from the move-list parity; `null` without a move list. */
	protected parityTurn(): Color | null {
		if (!this.hasMoveList()) return null;
		return this.getPly() % 2 === 0 ? "w" : "b";
	}

	protected clockState(side: Color): ClockState {
		const c = this.getClock(side);
		return c ? { ms: c.ms, running: c.running } : { ms: 0, running: false };
	}

	protected geometryCheck(): SelfCheckResult {
		const board = this.boardElement();
		const rect = this.getBoardRect();
		if (!board || !rect) return { name: "geometry", ok: false, detail: "no board" };
		return checkGeometry(board, rect, this.isFlipped(), this.doc);
	}

	/** The last move implied by two marked squares: the occupied one is the destination. */
	protected lastMoveBetween(
		placement: string,
		squares: readonly Square[]
	): { lastMove: { from: Square; to: Square } } | null {
		if (squares.length !== 2) return null;
		const [a, b] = squares as [Square, Square];
		const occA = pieceAt(placement, a) !== null;
		const occB = pieceAt(placement, b) !== null;
		if (occB && !occA) return { lastMove: { from: a, to: b } };
		if (occA && !occB) return { lastMove: { from: b, to: a } };
		return null;
	}

	/**
	 * Game identity for `AdapterReading.gameKey`; call once per `read()`.
	 * With a URL id the identity is that id. Without one, the serial advances
	 * when the board element is replaced or the ply count resets after ≥ 2 plies.
	 */
	protected gameIdentity(ply: number): string {
		const board = this.boardElement();
		if (board !== this.gameBoard) {
			if (this.gameBoard !== null) this.gameSerial++;
			this.gameBoard = board;
		}
		if (ply === 0 && this.gamePly >= 2) this.gameSerial++;
		this.gamePly = ply;
		const id = this.urlGameId();
		if (id !== null) return id;
		return `${this.win.location.pathname.replace(/\W+/g, "-")}#${this.gameSerial}`;
	}

	/** Log required selector misses and extra warnings only when they differ from the last probe. */
	protected reportProbe(
		report: ProbeReport,
		required: ReadonlySet<string>,
		warnings: string[]
	): void {
		const misses = report.misses.filter((c) => required.has(c));
		const signature = `${misses.join(",")}|${warnings.join(";")}`;
		if (signature === this.lastProbeSignature) return;
		this.lastProbeSignature = signature;
		for (const concern of misses) log.warn("adapter.selectorMiss", { site: this.site, concern });
		for (const w of warnings) log.warn(w);
	}

	/** Ask the page for its state (no-op until the bridge is ready); resolves once the cache is updated. */
	protected refreshBridgeState(): Promise<void> {
		const bridge = this.readyBridge();
		if (!bridge) return Promise.resolve();
		return bridge
			.call<BridgeState>(BRIDGE_KINDS.getState, undefined, BRIDGE_CALL_TIMEOUT_MS)
			.then((state) => {
				if (state && typeof state === "object") this.bridgeState = { ...this.bridgeState, ...state };
			})
			.catch(() => {
				// page side absent or slow: DOM readers carry on
			});
	}

	private disconnectObservers(): void {
		for (const o of this.observers) o.disconnect();
		this.observers.length = 0;
		for (const d of this.observerDisposers.splice(0)) d();
	}

	private wireBridge(): void {
		if (!this.bridge) return;
		const merge = (payload: unknown): void => {
			if (payload && typeof payload === "object")
				this.bridgeState = { ...this.bridgeState, ...(payload as BridgeState) };
			this.schedule();
		};
		for (const kind of [
			BRIDGE_KINDS.move,
			BRIDGE_KINDS.state,
			BRIDGE_KINDS.load,
			BRIDGE_KINDS.gameover,
		])
			this.disposers.push(this.bridge.on(kind, merge));
		this.disposers.push(this.bridge.on(BRIDGE_KINDS.ply, () => this.schedule()));
		// The page side may answer ready after construction: pick the bridge up then.
		this.disposers.push(
			this.bridge.on(BRIDGE_KINDS.ready, () => {
				void this.refreshBridgeState().then(() => {
					if (this.destroyed) return;
					this.schedule();
					this.probe();
				});
			})
		);
		void this.refreshBridgeState().then(() => {
			if (!this.primed) this.prime();
		});
	}

	/** Record the current state without firing (subscribers get changes, not the initial position). */
	private prime(): void {
		const reading = this.read();
		if (!reading) return;
		this.primed = true;
		this.lastKey = reading.key;
		this.lastColor = reading.snapshot.myColor;
		this.lastTimeControl = reading.snapshot.timeControl ?? null;
		this.lastGameKey = reading.gameKey;
		this.lastGameOver = reading.gameOver !== null;
		this.scheduleTimeControlProbe(reading);
	}

	/** Apply the DOM reading at once; when the bridge answers, apply again (dedupe absorbs no-ops). */
	private evaluate(): void {
		if (this.destroyed) return;
		this.apply();
		if (this.readyBridge()) void this.refreshBridgeState().then(() => this.apply());
	}

	private apply(): void {
		if (this.destroyed) return;
		const reading = this.read();
		if (!reading) return; // unstable: the next mutation re-triggers
		if (!this.primed) {
			this.prime();
			return;
		}
		const gameChanged = this.lastGameKey !== null && reading.gameKey !== this.lastGameKey;
		if (gameChanged) {
			this.lastGameKey = reading.gameKey;
			this.lastGameOver = false;
			this.timeControlProbes = 0;
			for (const cb of this.startCbs) cb();
			this.probe();
		}
		// Only for the game already being followed: a *different* board (an SPA hop to another page)
		// changes the colour along with everything else, and republishing its position would start a
		// second session on the same board.
		const colourLearned =
			!gameChanged && this.lastColor === null && reading.snapshot.myColor !== null;
		// Same shape, same reason (§4.3): the time control arrives after the first reading of the
		// game it belongs to, on a position that has not moved.
		const timeControlLearned =
			!gameChanged && this.lastTimeControl === null && reading.snapshot.timeControl !== undefined;
		this.lastColor = reading.snapshot.myColor;
		this.lastTimeControl = reading.snapshot.timeControl ?? null;
		if (reading.key !== this.lastKey || colourLearned || timeControlLearned) {
			this.lastKey = reading.key;
			for (const cb of this.positionCbs) cb(reading.snapshot);
		}
		this.scheduleTimeControlProbe(reading);
		const over = reading.gameOver !== null;
		if (over && !this.lastGameOver) {
			for (const cb of this.endCbs) cb(reading.gameOver ?? "*");
		}
		this.lastGameOver = over;
	}

	/**
	 * §4.3: re-ask the site for a time control it has not given us yet.
	 *
	 * `timeControl.get()` is `null` until the game actually starts, and two page signals normally
	 * land at that moment — the bridge's own `CreateGame` / `ModeChanged` event and the active
	 * clock gaining its turn class, both of which `schedule()` a re-evaluation that re-reads the
	 * bridge. Neither is guaranteed, and a first move planned without the time control runs the
	 * entire clockless branch, so this is the bounded safety net: while the page *shows clocks*
	 * (a timed game) and the site has not answered, ask again on a slow timer. Passive reads only
	 * (§13.3), capped per game, and never armed for a page with no clocks at all — an untimed
	 * computer game is not waiting for an answer, it has none.
	 */
	private scheduleTimeControlProbe(reading: AdapterReading): void {
		if (this.destroyed || this.timeControlTimer !== null) return;
		if (reading.snapshot.timeControl !== undefined) return;
		if (this.timeControlProbes >= TIME_CONTROL.maxProbes) return;
		const { w, b } = reading.snapshot.clocks;
		if (w.ms <= 0 && b.ms <= 0) return;
		if (!this.readyBridge()) return;
		this.timeControlProbes += 1;
		this.timeControlTimer = setTimeout(() => {
			this.timeControlTimer = null;
			this.schedule();
		}, TIMINGS.adapterTimeControlRetryMs);
	}

	private draw(
		highlights: Array<{ square: Square; color: string }>,
		arrows: Array<{ from: Square; to: Square; color: string }>
	): void {
		const bridge = this.readyBridge();
		if (!bridge) return; // no DOM insertion from the adapter (§13.3)
		bridge
			.call<{ keys?: string[] } | undefined>(
				BRIDGE_KINDS.draw,
				this.drawPayload(highlights, arrows),
				BRIDGE_CALL_TIMEOUT_MS
			)
			.then((res) => {
				if (res && Array.isArray(res.keys)) this.highlightKeys.push(...res.keys);
			})
			.catch((e: unknown) => {
				log.debug("adapter.draw failed", this.site, e);
			});
	}
}
