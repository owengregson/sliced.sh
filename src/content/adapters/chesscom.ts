/**
 * chess.com adapter (Appendix C §1, §3.4a). ISOLATED world: DOM readers
 * everywhere, the MAIN-world bridge (Task 21) preferred for FEN / turn /
 * colour / mode and for native markings when it is available.
 *
 * The class wires the chess.com readers into `AdapterBase`; the readers themselves live in
 * `chesscom/`:
 *   - `board.ts` — the board, move list and clock elements, and the renderer (DOM pieces or
 *     a canvas — detected behaviourally, never by class);
 *   - `position.ts` — the FEN / turn / ply ladders and the `observeMove` view;
 *   - `orientation.ts` — our colour, and which way round the board faces;
 *   - `page.ts` — the page kind, the URL's game id, the opponent's card;
 *   - `result.ts`, `time-control.ts`, `promotion.ts` — the game's result, time control and the
 *     promotion picker;
 *   - `control-targets.ts` — new game / resign / rematch discovery;
 *   - `observers.ts`, `probe.ts`, `draw-payload.ts` — what is watched, the self-check, and the
 *     mark's wire shapes.
 */

import { plyOf as fenPly, loadPosition, parseFen } from "@core/chess/fen";
import type {
	NewGameTargetResult,
	RematchAction,
	RematchTargetResult,
	ResignStep,
	ResignTargetResult,
} from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { Pt } from "@core/motor/types";
import type {
	Color,
	GameResult,
	PageKind,
	PromoPiece,
	Site,
	Square,
	TimeControl,
} from "@typedefs/game";
import {
	AdapterBase,
	type AdapterOptions,
	type AdapterPositionSnapshot,
	type AdapterReading,
	type ClockReading,
	type DrawOptions,
	type MoveWatch,
	type NewGameMode,
	type Opponent,
	type PositionInfo,
	type ProbeReport,
	type Rect,
	type SiteAdapter,
	toRect,
} from "./adapter";
import type { ArrowMark, SquareMark } from "./base/markings";
import { boardOf, domPlacementOf, midGesture, moveListOf, rendererOf } from "./chesscom/board";
import { ControlTargets } from "./chesscom/control-targets";
import { clearPayloadOf, drawPayloadOf } from "./chesscom/draw-payload";
import {
	installChesscomObservers,
	type WatchedElements,
	watchedElementsOf,
	watchedReplaced,
} from "./chesscom/observers";
import { bottomColorOf, flippedOf, myColourOf } from "./chesscom/orientation";
import { opponentOf, pageKindOf, urlGameIdOf } from "./chesscom/page";
import {
	bridgeLastMoveOf,
	bridgeTurnOf,
	moveWatchOf,
	type PositionSources,
	plyOf,
	positionInfoFor,
	reconciledTurn,
	sideToMoveFor,
} from "./chesscom/position";
import { probeReportOf, REQUIRED_LADDERS } from "./chesscom/probe";
import { promotionTargetRectOf } from "./chesscom/promotion";
import { gameResultOf } from "./chesscom/result";
import { timeControlOf } from "./chesscom/time-control";
import { activeClockColor, readClock, readComputerClock } from "./clocks";
import { placementOf, replayMoves } from "./dom-fen";
import { type MoveList, readMoveList } from "./move-list";

const SITE: Site = "chesscom";

const NOTHING_WATCHED: WatchedElements = { board: null, moveList: null, clocks: [] };

export class ChessComAdapter extends AdapterBase implements SiteAdapter {
	readonly site = SITE;
	private readonly controls = new ControlTargets({
		doc: this.doc,
		win: this.win,
		currentGameId: () => this.urlGameId() ?? this.readSnapshot()?.gameId,
		inGame: () => this.inGame(),
	});
	/** The elements the current observer set watches (a reading re-installs when one is replaced). */
	private watched: WatchedElements = NOTHING_WATCHED;

	constructor(options: AdapterOptions = {}) {
		super(options, TIMINGS.adapterDebounceMs, TIMINGS.adapterSelfCheckIntervalMs);
		this.start();
	}

	// ---- page / players ------------------------------------------------------------

	detectPageKind(): PageKind {
		return pageKindOf(this.doc, this.win, this.bridgeState);
	}

	getOpponent(): Opponent | null {
		return opponentOf(this.doc, this.detectPageKind());
	}

	isReady(): boolean {
		return this.boardElement() !== null;
	}

	/** See `myColourOf`: the site's `getPlayingAs()` once the bridge has a mode, else the page. */
	getMyColor(): Color | null {
		return myColourOf(
			this.bridgeState,
			() => this.detectPageKind(),
			() => bottomColorOf(this.doc)
		);
	}

	// ---- position -----------------------------------------------------------------

	getPlacement(): string | null {
		return domPlacementOf(this.boardElement());
	}

	getPositionInfo(): PositionInfo | null {
		return positionInfoFor(this.sources(this.getPlacement(), readMoveList(this.doc)));
	}

	getSideToMove(): Color | null {
		return sideToMoveFor(this.sources(this.getPlacement(), readMoveList(this.doc)));
	}

	getClock(side: Color): ClockReading | null {
		const clock = readClock(this.doc, side);
		if (clock) return clock;
		// A positive site time control distinguishes countdowns from the computer page's
		// identically styled elapsed-move counters. These clocks have no active-side class.
		if (this.detectPageKind() !== "vs-computer" || !this.getTimeControl()) return null;
		const info = this.getPositionInfo();
		const observedTurn = this.getSideToMove();
		const runningSide =
			info && observedTurn && this.isAtLivePosition() && !this.isGameOver()
				? reconciledTurn(info, observedTurn)
				: null;
		return readComputerClock(this.doc, side, runningSide);
	}

	/** §4.3 — see `timeControlOf`. */
	getTimeControl(): TimeControl | null {
		return timeControlOf(
			this.doc,
			this.detectPageKind() === "vs-computer",
			this.bridgeState?.timeControl
		);
	}

	getMoveList(): string[] {
		return readMoveList(this.doc).sans;
	}

	getPly(): number {
		return plyOf(readMoveList(this.doc));
	}

	isAtLivePosition(): boolean {
		const list = readMoveList(this.doc);
		return list.selectedIndex === -1 || list.selectedIndex === list.sans.length - 1;
	}

	isGameOver(): boolean {
		return this.gameResultFor(readMoveList(this.doc)) !== null;
	}

	// ---- geometry -----------------------------------------------------------------

	getBoardRect(): Rect | null {
		const board = this.boardElement();
		return board ? toRect(board.getBoundingClientRect()) : null;
	}

	/** "Black at the bottom" — see `flippedOf` (`getOptions().flipped` alone when the bridge says). */
	isFlipped(): boolean {
		return flippedOf(
			this.bridgeState,
			this.boardElement(),
			() => bottomColorOf(this.doc),
			() => this.getMyColor()
		);
	}

	getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null {
		return promotionTargetRectOf(this.doc, () => this.getMyColor(), dest, piece);
	}

	// ---- actions ------------------------------------------------------------------

	/** Discover a control without activating it, or revalidate the exact element under a point. */
	newGameTarget(
		mode: NewGameMode,
		expectedGameId?: string | null,
		targetId?: string,
		point?: Pt
	): NewGameTargetResult {
		return this.controls.newGame(mode, expectedGameId, targetId, point);
	}

	rematchTarget(action: RematchAction, targetId?: string, point?: Pt): RematchTargetResult {
		return this.controls.rematch(action, targetId, point);
	}

	incomingRematch(): boolean {
		return this.controls.incomingRematch();
	}

	resignTarget(step: ResignStep, targetId?: string, point?: Pt): ResignTargetResult {
		return this.controls.resign(step, targetId, point);
	}

	probe(): ProbeReport {
		const board = this.boardElement();
		const placement = this.getPlacement();
		const list = readMoveList(this.doc);
		const report = probeReportOf({
			site: SITE,
			doc: this.doc,
			board,
			placement,
			list,
			info: positionInfoFor(this.sources(placement, list)),
			bottom: bottomColorOf(this.doc),
			bridgeState: this.bridgeState,
			turns: {
				bridge: bridgeTurnOf(this.bridgeState),
				clock: activeClockColor(this.doc),
				parity: this.parityTurn(),
			},
			geometry: this.geometryCheck(),
			bridgeUp: this.bridge ? this.readyBridge() !== null && this.bridgeState !== null : null,
		});
		this.reportProbe(report, REQUIRED_LADDERS, []);
		return report;
	}

	// ---- AdapterBase hooks --------------------------------------------------------

	protected installObservers(): void {
		this.watched = this.watchedNow();
		installChesscomObservers(
			{
				doc: this.doc,
				win: this.win,
				observe: (target, init, filter) => this.observe(target, init, filter),
				addObserverDisposer: (fn) => this.addObserverDisposer(fn),
				touches: (records, selector) => this.touches(records, selector),
				schedule: () => this.schedule(),
			},
			this.watched
		);
	}

	protected read(): AdapterReading | null {
		const board = this.boardElement();
		if (!board) return null;
		// The move list and computer clocks can first appear after play starts.
		if (watchedReplaced(this.watched, this.watchedNow())) this.reinstallObservers();
		const domPieces = rendererOf(board) === "pieces";
		// DOM renderer only: a `.piece.dragging` means the markup is mid-gesture. The WebGL board
		// has no piece element to drag, and `game.getFEN()` moves only on a completed move.
		if (domPieces && midGesture(board)) return null;
		const placement = this.getPlacement();
		const list = readMoveList(this.doc);
		const sources = this.sources(placement, list);
		const info = positionInfoFor(sources);
		// `positionInfoFor` is the position source (bridge → replay → DOM); the DOM placement is
		// only one of its inputs, and a WebGL board never has one.
		if (!info) return null;
		// A board that renders pieces but cannot be read is mid-animation: retry on the next record.
		if (domPieces && placement === null) return null;
		const sideToMove = reconciledTurn(info, sideToMoveFor(sources));
		// The exact board can lead the move-list render by several fast opening plies.
		// Never assign that board the old list's ply or attach its stale last move.
		const parts = info.approximate ? null : parseFen(info.fen);
		const ply = parts ? fenPly(parts) : plyOf(list);
		const candidate = replayMoves(list.sans.slice(0, ply));
		const replay = candidate && candidate.fen === loadPosition(info.fen)?.fen() ? candidate : null;
		const lastMove = replay?.lastMove ?? bridgeLastMoveOf(this.bridgeState);
		const gameOver = this.gameResultFor(list);
		const computer = this.detectPageKind() === "vs-computer";
		const gameId = this.gameIdentity(
			ply,
			gameOver !== null,
			computer && this.bridgeState?.gameOver === false && this.isAtLivePosition()
		);
		const timeControl = this.getTimeControl();
		const snapshot: AdapterPositionSnapshot = {
			site: SITE,
			gameId,
			fen: info.fen,
			approximate: info.approximate,
			ply,
			sideToMove,
			myColor: this.getMyColor(),
			...(lastMove ? { lastMove } : {}),
			...(replay ? { moveHistory: list.sans.slice(0, ply) } : {}),
			clocks: { w: this.clockState("w"), b: this.clockState("b") },
			// §4.3: the site's own `{baseTime, increment}`, once it answers — `null` until the game
			// actually starts, which is why `SnapshotPublisher.apply` republishes an unmoved position when
			// it arrives and why the session re-profiles on it.
			...(timeControl ? { timeControl } : {}),
			capturedAt: Date.now(),
		};
		return {
			// Keyed off the position actually published: the DOM placement is `null` for the
			// whole of a WebGL game, which would dedupe every move away.
			key: `${this.gameGeneration}|${placementOf(info.fen)}|${sideToMove}`,
			snapshot,
			gameOver,
			gameKey: gameId,
		};
	}

	/** What `observeMove` compares — see `moveWatchOf`. */
	protected watchMove(): MoveWatch {
		return moveWatchOf(this.sources(this.getPlacement(), readMoveList(this.doc)));
	}

	protected drawPayload(
		highlights: SquareMark[],
		arrows: ArrowMark[],
		options: DrawOptions
	): unknown {
		return drawPayloadOf(highlights, arrows, options, this.isFlipped());
	}

	protected clearPayload(): unknown {
		return clearPayloadOf(this.highlightKeys);
	}

	protected boardElement(): Element | null {
		return boardOf(this.doc);
	}

	protected hasMoveList(): boolean {
		return moveListOf(this.doc) !== null;
	}

	protected urlGameId(): string | null {
		return urlGameIdOf(this.win);
	}

	// ---- private readers ----------------------------------------------------------

	private sources(placement: string | null, list: MoveList): PositionSources {
		return { doc: this.doc, bridgeFen: this.bridgeFen(), placement, list };
	}

	private watchedNow(): WatchedElements {
		return watchedElementsOf(this.doc, this.detectPageKind() === "vs-computer");
	}

	/** A game is being played on this board: a running clock, or the bridge saying so. */
	private inGame(): boolean {
		if (this.detectPageKind() === "live-postgame") return false;
		const running = [this.getClock("w"), this.getClock("b")].some(
			(clock) => clock?.running && clock.ms > 0
		);
		const playing = this.bridgeState?.mode === "playing" && this.bridgeState.gameOver === false;
		return (
			!this.isGameOver() &&
			this.getMyColor() !== null &&
			this.getFen() !== null &&
			(running || playing)
		);
	}

	private gameResultFor(list: MoveList): GameResult | null {
		return gameResultOf(
			this.doc,
			this.bridgeState,
			list,
			() => this.detectPageKind(),
			() => this.getMyColor()
		);
	}
}

export function createChesscomAdapter(options: AdapterOptions = {}): SiteAdapter {
	return new ChessComAdapter(options);
}
