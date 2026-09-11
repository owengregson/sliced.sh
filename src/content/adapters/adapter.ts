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

import { turnFieldOf } from "@core/chess/fen";
import type { UciParts } from "@core/chess/san";
import { EXECUTOR } from "@core/constants/cdp";
import { LIMITS } from "@core/constants/limits";
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
 *
 * The current state is reported **once at install**, before any edge. Without it the service
 * worker's `FocusGate` has no reading at all until the page first gains or loses focus, and
 * `canExecute` answers `unfocused` while it has none — so a tab that was already focused when the
 * content script loaded, armed with the `Shift+A` shortcut (which by design produces no focus edge),
 * would have every move skipped and nothing to release it. Playing white at ply 0 that is the
 * owner's "it sometimes doesnt make the first move" with no focus edge anywhere in sight. This is a
 * passive read of `document.hasFocus()` — the same one every edge makes — and moves focus nowhere.
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
	report();
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
	/** Colour *corrections* this game has already published (`LIMITS.colourCorrectionsPerGame`). */
	private colourCorrections = 0;
	/**
	 * This game spent its corrections and the site then offered another, so the colour is **withheld**
	 * for the rest of it: the cap may bound the republishing, but it may never leave the session
	 * holding a colour we know to be wrong (review R-1).
	 */
	private colourWithheld = false;
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
		return this.reading()?.snapshot ?? null;
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
		// `scroll` fires far more often than the board moves, so it is coalesced per animation frame
		// rather than debounced on a timer: the report feeds the hand's mid-drag reflow guard, so it
		// must land within a frame of the page settling, not 40 ms later. `resize` — the infobar's
		// own signal — and the `ResizeObserver` (already frame-aligned) report at once.
		//
		// **Leading edge**: the first scroll of a burst reports immediately and the rest of that
		// frame is coalesced into one trailing report. Trailing-only cost the guard a whole frame on
		// the very first movement, which is the movement that matters; and the trailing report is
		// what makes the *final* rect of a burst known, without which a board that stopped somewhere
		// new could still look unmoved to the guard. At most two reports per frame either way, and
		// `reportBoardRect` drops the ones that moved nothing.
		let frame: number | null = null;
		let pending = false;
		const raf = this.rafOf();
		const coalesced = (): void => {
			if (!raf) {
				report();
				return;
			}
			if (frame !== null) {
				pending = true;
				return;
			}
			report();
			frame = raf(() => {
				frame = null;
				if (!pending) return;
				pending = false;
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
			pending = false;
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
	/**
	 * Every reading this class hands out or publishes, with the one invariant that must hold of
	 * every published `PositionSnapshot`: **`sideToMove` is the turn field of the `fen` beside it.**
	 *
	 * It lives here rather than only in the adapter because this is the single place every snapshot
	 * passes through — `readSnapshot()` (the content script's first publish), `prime()` and
	 * `apply()`. A site adapter that derives the two from different ladders, as the chess.com one
	 * does (bridge → clock → move-list parity against bridge → replay → DOM), can answer
	 * `sideToMove: "b"` beside a FEN that says white; `GameSession.myTurn` reads `sideToMove` while
	 * every search, plan and mark downstream is for whoever the FEN says is to move, so the
	 * contradiction is what makes the assistant recommend the opponent's move and call it ours
	 * (owner's live game, 2026-09-10). `ChessComAdapter.reconciledTurn` settles it as it reads, where
	 * the dedupe key is built from the same value; this is the backstop for every adapter.
	 *
	 * The corrected turn is **appended to the dedupe key**. The key is the subclass's own string and
	 * normally embeds the turn it published, so correcting one without the other would let two
	 * different positions share a key; appending keeps the key a function of what is actually
	 * published without this class having to know the subclass's format.
	 *
	 * `turnFieldOf`, not `sideToMove`: see the note on the former — a strict parse would answer
	 * `null` for a FEN with one malformed field and silently leave the contradiction in place.
	 */
	private reading(): AdapterReading | null {
		const raw = this.read();
		if (raw === null) return null;
		const myColor = this.statedColour(raw.snapshot.myColor);
		const reading =
			myColor === raw.snapshot.myColor ? raw : { ...raw, snapshot: { ...raw.snapshot, myColor } };
		const turn = turnFieldOf(reading.snapshot.fen);
		if (turn === null || turn === reading.snapshot.sideToMove) return reading;
		log.warn("adapter.turnInvariantViolated", {
			site: this.site,
			fenTurn: turn,
			sideToMove: reading.snapshot.sideToMove,
		});
		return {
			...reading,
			key: `${reading.key}|${turn}`,
			snapshot: { ...reading.snapshot, sideToMove: turn },
		};
	}

	/**
	 * Which colour this class is willing to *state*, given what it has already delivered.
	 *
	 * `getMyColor()`'s last rung is the board's own rendering, and a board the owner turned round by
	 * hand reads the other way. So the render may **supply** a colour when none is known and may never
	 * **replace** one: only the site's own `getPlayingAs()` can change a colour already delivered.
	 *
	 * That rule is about the evidence, not about the position — which is the whole of review R-2.
	 * Gating only the republish of an *unmoved* position left the refused flip riding in on the next
	 * real move, where the key changes and the reading is published for its own sake; with the bridge
	 * silent there is then no authoritative answer to undo it, so the owner got recommendations and
	 * marks for the opponent's side for the rest of the game. A position advancing does not make the
	 * rendering authoritative, and whether the owner flipped the board between moves or during one
	 * makes no difference to what the flip means.
	 */
	private statedColour(offered: Color | null): Color | null {
		if (this.colourWithheld) return null;
		const known = this.lastColor;
		// Nothing delivered yet (the live page's first second), or nothing new to say.
		if (known === null || offered === known) return offered;
		// The site's own answer is the only thing that may overturn a delivered colour…
		if (offered !== null && offered === this.authoritativeColour()) return offered;
		// …and anything else keeps what the session already has. Including `null`: losing sight of the
		// clocks for a frame is not evidence that the colour changed.
		return known;
	}

	/** The colour as the *site* states it (`getPlayingAs()`), as opposed to as the board renders it. */
	protected authoritativeColour(): Color | null {
		return bridgeColor(this.bridgeState?.playingAs);
	}

	private prime(): void {
		const reading = this.reading();
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
		const reading = this.reading();
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
			this.colourCorrections = 0;
			this.colourWithheld = false;
			for (const cb of this.startCbs) cb();
			this.probe();
		}
		// A colour that *changes* from one definite answer to another is delivered, whatever else
		// moved — but only on the authority of the site's own `getPlayingAs()`, and only a bounded
		// number of times per game.
		//
		// Why it must be delivered at all: the dedupe key is the position, so every reading of ply 0
		// shares one string, and the live page's first readable moment can answer the wrong colour —
		// the clocks before the board is turned round, a lobby board still showing white at the
		// bottom, or the bridge cache holding the previous game's `playingAs` (`refreshBridgeState`
		// merges, and `evaluate()` reads before it refreshes). Publishing only `null → known` left a
		// `"w" → "b"` correction with no way through at all, and the session kept predicting,
		// highlighting and playing for the *opponent* until the position itself moved on (owner's live
		// game, 2026-09-10: white's first move, recommended to a black player, for the whole of
		// white's turn). The new game's own first reading is the likeliest place to need it, because
		// the lobby board it replaces answered the colour of the *last* game.
		//
		// Why only the bridge may do it: `getMyColor()`'s last rung is the board's own **rendering**
		// (`bottomColor()`), and the rendering is exactly what a manual board flip changes, so a render
		// reading may introduce a colour but never overturn one. `statedColour` is where that rule
		// lives — it applies to every reading, on a new position as much as on an unmoved one — and the
		// authority test here is the republish side of it: a correction is a reason to deliver an
		// *unmoved* position again.
		//
		// Why it is capped: every other republish trigger here is structurally one-shot
		// (`colourLearned` needs `lastColor === null`, `timeControlLearned` needs `lastTimeControl ===
		// null`, and nothing restores either). This one is not, so an alternating answer would start
		// and abort a pipeline — and flood the game port with marks — once per reading, for ever.
		//
		// And what the cap does when it runs out is **withhold the colour**, not keep the one we have.
		// A cap that keeps a stale colour fails in the one direction this whole lane forbids: the site
		// has just told us the owner is playing the other side, so continuing to state the old one
		// leaves the session recommending, marking and scheduling for the opponent — silently, and for
		// the rest of the game, with a snapshot internally consistent enough that every guard passes
		// (review R-1). Answering "no colour" is the honest tail: `GameSession.mayActOn` holds on it
		// exactly as it holds on the live page's first second, so the assistant acts for *neither*
		// side, and the refusal says so in the log.
		const authoritative = this.authoritativeColour();
		if (
			!this.colourWithheld &&
			this.lastColor !== null &&
			authoritative !== null &&
			authoritative !== this.lastColor &&
			this.colourCorrections >= LIMITS.colourCorrectionsPerGame
		) {
			this.colourWithheld = true;
			log.warn("adapter.colourWithheld", {
				site: this.site,
				told: this.lastColor,
				offered: authoritative,
				corrections: this.colourCorrections,
			});
		}
		// `reading` was built before that decision, so the withhold is applied to what is published
		// here (`statedColour` applies it to every later reading, `readSnapshot()` included).
		const snapshot = this.colourWithheld
			? ({ ...reading.snapshot, myColor: null } as typeof reading.snapshot)
			: reading.snapshot;
		// Neither the authority test nor the cap appears here, and both absences are deliberate:
		// `statedColour` has already decided what this class is *willing* to state, so a colour that
		// differs from the last delivered one is authoritative by construction, and the withhold above
		// fires at the cap and empties `snapshot.myColor`. Both conjuncts were in this expression and
		// both were dead — mutations removing them survived the whole suite, which is the measurement
		// that says the rule lives in one place now rather than three.
		const colourChanged =
			this.lastColor !== null && snapshot.myColor !== null && this.lastColor !== snapshot.myColor;
		if (colourChanged) this.colourCorrections += 1;
		// The withhold itself has to reach the session, or it is just as silent as keeping the stale
		// colour was. It fires once: `lastColor` is `null` afterwards.
		const colourWithdrawn = this.colourWithheld && this.lastColor !== null;
		// Learning a colour from nothing is different, and stays limited to the game already being
		// followed: an SPA hop to another page (`/game/<id>` → `/analysis/…` → `/play/computer`)
		// changes the derived game id and re-reads the colour from a board that is no longer the one
		// we were following, and republishing there would start a second session on it.
		const colourLearned = !gameChanged && this.lastColor === null && snapshot.myColor !== null;
		// Same shape, same reason (§4.3): the time control arrives after the first reading of the
		// game it belongs to, on a position that has not moved.
		const timeControlLearned =
			!gameChanged && this.lastTimeControl === null && reading.snapshot.timeControl !== undefined;
		this.lastTimeControl = reading.snapshot.timeControl ?? null;
		if (
			reading.key !== this.lastKey ||
			colourChanged ||
			colourWithdrawn ||
			colourLearned ||
			timeControlLearned
		) {
			this.lastKey = reading.key;
			// `lastColor` is what the session has actually been *told*, so it advances only with a
			// delivery. Advancing it on every reading let a colour this class had just refused to
			// deliver — a render flip — still overwrite the baseline, and the authoritative answer that
			// arrived next then looked like no change at all and was dropped in its turn. (Measured:
			// it broke the owner's own repro, `colour-turn.test.ts:94`.)
			this.lastColor = snapshot.myColor;
			for (const cb of this.positionCbs) cb(snapshot);
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
