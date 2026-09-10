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
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
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
	/** SAN, main line only. */
	getMoveList(): string[];
	/** Plies played (main line) / current ply if browsing. */
	getPly(): number;
	isAtLivePosition(): boolean;
	isGameOver(): boolean;
	isMyTurn(): boolean;

	/** 8×8 playing area only. */
	getBoardRect(): Rect | null;
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
	private lastGameKey: string | null = null;
	private lastGameOver = false;
	private lastProbeSignature: string | null = null;
	private gameSerial = 0;
	private gameBoard: Element | null = null;
	private gamePly = -1;
	private selfCheckTimer: ReturnType<typeof setInterval> | null = null;
	private destroyed = false;
	private primed = false;

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
		this.disconnectObservers();
		for (const d of this.disposers.splice(0)) d();
		this.positionCbs.clear();
		this.startCbs.clear();
		this.endCbs.clear();
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
		this.lastGameKey = reading.gameKey;
		this.lastGameOver = reading.gameOver !== null;
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
		if (this.lastGameKey !== null && reading.gameKey !== this.lastGameKey) {
			this.lastGameKey = reading.gameKey;
			this.lastGameOver = false;
			for (const cb of this.startCbs) cb();
			this.probe();
		}
		if (reading.key !== this.lastKey) {
			this.lastKey = reading.key;
			for (const cb of this.positionCbs) cb(reading.snapshot);
		}
		const over = reading.gameOver !== null;
		if (over && !this.lastGameOver) {
			for (const cb of this.endCbs) cb(reading.gameOver ?? "*");
		}
		this.lastGameOver = over;
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
