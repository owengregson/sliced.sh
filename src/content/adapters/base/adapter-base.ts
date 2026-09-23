/**
 * `AdapterBase` — the board-watching runtime every site adapter shares, independent of any
 * markup: debounced re-evaluation, observer bookkeeping, the bridge-state cache, `observeMove`,
 * game identity, probe reporting. A site adapter (`chesscom.ts`) supplies only the DOM/bridge
 * reading through the abstract hooks below. It is the seam the adapter tests drive. No adapter
 * method reads or writes page storage (§13.3).
 *
 * Each concern lives in its own part, composed here:
 *   - `SnapshotPublisher` — prime/apply, the dedupe and every republish trigger, with the colour
 *     lane (`ColourAuthority`) and the time-control re-ask (`TimeControlProbe`);
 *   - `ObserverSet` — the replaceable per-board watchers;
 *   - `BoardRectWatch` — §9.5 board-rect reports;
 *   - `BridgeStateCache` — the merged bridge state;
 *   - `Markings` — the recommendation mark;
 *   - `GameIdentity`, `ProbeLog`, and `observeMove` (`move-observation.ts`).
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
import { TOKENS } from "@design/tokens.generated";
import type {
	ClockState,
	Color,
	GameResult,
	HighlightStyle,
	PageKind,
	PromoPiece,
	Site,
	Square,
	TimeControl,
} from "@typedefs/game";
import { BRIDGE_KINDS, type BridgeState, bridgeColor, type PageBridge } from "../bridge-protocol";
import type {
	AdapterOptions,
	AdapterPositionSnapshot,
	AdapterReading,
	ArrowLine,
	ClockReading,
	DrawOptions,
	FocusEdge,
	MoveWatch,
	NewGameMode,
	Opponent,
	Point,
	PositionInfo,
	ProbeReport,
	Rect,
	SelfCheckResult,
	SiteAdapter,
} from "../contract";
import { lastMoveBetween } from "../dom-fen";
import { pointToSquare as pointToSquareGeom, squareRect as squareRectGeom } from "../geometry";
import { checkGeometry } from "../self-check";
import { BoardRectWatch } from "./board-rect-watch";
import { BridgeStateCache } from "./bridge-cache";
import { debounced } from "./debounce";
import { installFocusEdges } from "./focus-edges";
import { GameIdentity } from "./game-identity";
import { type ArrowMark, type HighlightColors, Markings, type SquareMark } from "./markings";
import { observeMove } from "./move-observation";
import { ObserverSet, recordsTouch } from "./observer-set";
import { mutationObserverOf } from "./page-constructors";
import { ProbeLog } from "./probe-log";
import { SnapshotPublisher } from "./publisher";

/** Shared adapter runtime: listeners, debounced evaluation, bridge cache, highlight keys, self-check timer. */
export abstract class AdapterBase implements SiteAdapter {
	abstract readonly site: Site;
	protected readonly doc: Document;
	protected readonly win: Window;
	/** The bridge object is kept even before the page side is ready; `readyBridge()` gates every use. */
	protected readonly bridge: PageBridge | null;
	protected readonly theme: "dark" | "light";
	private readonly bridgeCache = new BridgeStateCache();
	private readonly markings: Markings;
	private readonly publisher: SnapshotPublisher;
	private readonly observers: ObserverSet;
	private readonly rectWatch: BoardRectWatch;
	private readonly identity = new GameIdentity();
	private readonly probeLog: ProbeLog;
	private readonly disposers: Array<() => void> = [];
	private readonly pending: { trigger(): void; cancel(): void };
	private selfCheckTimer: ReturnType<typeof setInterval> | null = null;
	private destroyed = false;

	constructor(options: AdapterOptions, debounceMs: number, selfCheckMs: number) {
		this.doc = options.document ?? document;
		this.win = options.window ?? window;
		this.bridge = options.bridge ?? null;
		this.theme = options.theme ?? "dark";
		const self = this;
		const isDestroyed = (): boolean => this.destroyed;
		this.markings = new Markings({
			get site() {
				return self.site;
			},
			readyBridge: () => this.readyBridge(),
			colors: () => this.colors(),
			drawPayload: (highlights, arrows, drawOptions) =>
				this.drawPayload(highlights, arrows, drawOptions),
			clearPayload: () => this.clearPayload(),
		});
		this.publisher = new SnapshotPublisher({
			get site() {
				return self.site;
			},
			read: () => this.read(),
			detectPageKind: () => this.detectPageKind(),
			authoritativeColour: () => this.authoritativeColour(),
			probe: () => {
				this.probe();
			},
			destroyed: isDestroyed,
			bridgeReady: () => this.readyBridge() !== null,
			schedule: () => this.schedule(),
		});
		this.observers = new ObserverSet(() => mutationObserverOf(this.win));
		this.rectWatch = new BoardRectWatch({
			win: this.win,
			doc: this.doc,
			boardElement: () => this.boardElement(),
			getBoardRect: () => this.getBoardRect(),
			destroyed: isDestroyed,
			addDisposer: (fn) => this.disposers.push(fn),
		});
		this.probeLog = new ProbeLog(() => this.site);
		this.pending = debounced(() => this.evaluate(), debounceMs);
		this.selfCheckTimer = setInterval(() => {
			if (!this.destroyed) this.probe();
		}, selfCheckMs);
	}

	/** Site adapters call this at the end of their constructor (observers need the subclass fields). */
	protected start(): void {
		this.reinstallObservers();
		this.wireBridge();
		this.publisher.prime();
		this.probe();
	}

	// ---- abstract site readers -------------------------------------------------

	/** Register every MutationObserver / listener through `observe` / `addObserverDisposer`. */
	protected abstract installObservers(): void;
	/** `null` while the board is unstable (dragging, animating, promotion dialog open). */
	protected abstract read(): AdapterReading | null;
	protected abstract watchMove(): MoveWatch;
	protected abstract drawPayload(
		highlights: SquareMark[],
		arrows: ArrowMark[],
		options: DrawOptions
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
	abstract newGameTarget(
		mode: NewGameMode,
		expectedGameId?: string | null,
		targetId?: string,
		point?: Pt
	): NewGameTargetResult;
	abstract resignTarget(step: ResignStep, targetId?: string, point?: Pt): ResignTargetResult;
	abstract rematchTarget(action: RematchAction, targetId?: string, point?: Pt): RematchTargetResult;
	abstract incomingRematch(): boolean;
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

	/** §9.5 — see `BoardRectWatch`. */
	onBoardRect(cb: (rect: Rect) => void): () => void {
		return this.rectWatch.subscribe(cb);
	}

	readSnapshot(): AdapterPositionSnapshot | null {
		if (this.destroyed) return null;
		return this.publisher.reading()?.snapshot ?? null;
	}

	onPositionChange(cb: (s: AdapterPositionSnapshot) => void): () => void {
		return this.publisher.position.on(cb);
	}

	onGameStart(cb: () => void): () => void {
		return this.publisher.gameStart.on(cb);
	}

	onPageKindChange(cb: () => void): () => void {
		return this.publisher.pageKind.on(cb);
	}

	onGameEnd(cb: (result: GameResult) => void): () => void {
		return this.publisher.gameEnd.on(cb);
	}

	highlight(from: Square, to: Square, style: HighlightStyle, options: DrawOptions = {}): void {
		this.markings.highlight(from, to, style, options);
	}

	arrows(lines: ArrowLine[], options: DrawOptions = {}): void {
		this.markings.arrows(lines, options);
	}

	clearHighlights(): Promise<void> {
		return this.markings.clear();
	}

	observeMove(expected: ExpectedMove, timeoutMs: number): Promise<boolean> {
		return observeMove(
			{
				doc: this.doc,
				watchMove: () => this.watchMove(),
				refreshBridgeState: () => this.refreshBridgeState(),
				observerCtor: () => mutationObserverOf(this.win),
			},
			expected,
			timeoutMs
		);
	}

	destroy(): void {
		this.destroyed = true;
		this.pending.cancel();
		if (this.selfCheckTimer !== null) clearInterval(this.selfCheckTimer);
		this.selfCheckTimer = null;
		this.publisher.dispose();
		this.observers.disconnect();
		for (const d of this.disposers.splice(0)) d();
		this.publisher.clearSubscribers();
		this.rectWatch.clear();
	}

	// ---- helpers for subclasses --------------------------------------------------

	/** The merged bridge state (`null` until the page side has said anything). */
	protected get bridgeState(): BridgeState | null {
		return this.bridgeCache.state;
	}

	/** Keys of the recommendation marks currently drawn (the site's clear may name them). */
	protected get highlightKeys(): readonly string[] {
		return this.markings.keys;
	}

	protected observe(
		target: Node | null,
		init: MutationObserverInit,
		filter?: (records: MutationRecord[]) => boolean
	): void {
		this.observers.observe(target, init, (records) => {
			if (filter && !filter(records)) return;
			this.schedule();
		});
	}

	/** Listener removers that belong to the current observer set (dropped on re-install). */
	protected addObserverDisposer(fn: () => void): void {
		this.observers.addDisposer(fn);
	}

	/** Disconnect every observer/listener from `installObservers` and install afresh (containers replaced). */
	protected reinstallObservers(): void {
		this.observers.disconnect();
		this.installObservers();
		this.rectWatch.retarget();
	}

	/** Does any added/removed element of `records` match (or contain) `selector`? */
	protected touches(records: MutationRecord[], selector: string): boolean {
		return recordsTouch(records, selector);
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

	/** The bridge, only once its page side has answered ready (consulted at every use). */
	protected readyBridge(): PageBridge | null {
		return this.bridge?.isAvailable() ? this.bridge : null;
	}

	protected bridgeFen(): string | null {
		return this.bridgeCache.fen;
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
		return lastMoveBetween(placement, squares);
	}

	/**
	 * Game identity for `AdapterReading.gameKey`; call once per `read()` (see `GameIdentity`).
	 * With a URL id the identity is that id; without one, `<path>#<serial>`.
	 */
	protected gameIdentity(ply: number, ended = false, active = false): string {
		this.identity.advance(this.boardElement(), ply, ended, active);
		const id = this.urlGameId();
		if (id !== null) return id;
		return this.identity.pathKey(this.win.location.pathname);
	}

	/** Changes for a new board/game, independently of a route changing around the old board. */
	protected get gameGeneration(): number {
		return this.identity.generation;
	}

	/** Log required selector misses and extra warnings only when they differ from the last probe. */
	protected reportProbe(
		report: ProbeReport,
		required: ReadonlySet<string>,
		warnings: string[]
	): void {
		this.probeLog.report(report, required, warnings);
	}

	/** Ask the page for its state (no-op until the bridge is ready); resolves once the cache is updated. */
	protected refreshBridgeState(): Promise<BridgeState | null> {
		return this.bridgeCache.refresh(this.readyBridge());
	}

	/** The colour as the *site* states it (`getPlayingAs()`), as opposed to as the board renders it. */
	protected authoritativeColour(): Color | null {
		return bridgeColor(this.bridgeState?.playingAs);
	}

	private wireBridge(): void {
		if (!this.bridge) return;
		const merge = (payload: unknown): void => {
			this.bridgeCache.merge(payload);
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
			if (!this.publisher.primed) this.publisher.prime();
		});
	}

	/** Apply the DOM reading at once; when the bridge answers, apply again (dedupe absorbs no-ops). */
	private evaluate(): void {
		if (this.destroyed) return;
		this.publisher.apply();
		if (this.readyBridge()) void this.refreshBridgeState().then(() => this.publisher.apply());
	}
}
