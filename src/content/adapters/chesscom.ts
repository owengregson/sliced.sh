/**
 * chess.com adapter (Appendix C §1, §3.4a). ISOLATED world: DOM readers
 * everywhere, the MAIN-world bridge (Task 21) preferred for FEN / turn /
 * colour / mode and for native markings when it is available.
 */

import { squareOf } from "@core/chess/squares";
import { TIMINGS } from "@core/constants/timings";
import type { Color, GameResult, PageKind, PromoPiece, Site, Square } from "@typedefs/game";
import {
	AdapterBase,
	type AdapterOptions,
	type AdapterPositionSnapshot,
	type AdapterReading,
	bridgeColor,
	type ClockReading,
	type MoveWatch,
	type NewGameMode,
	type Opponent,
	type PositionInfo,
	type ProbeReport,
	type Rect,
	type SiteAdapter,
	toRect,
} from "./adapter";
import { activeClockColor, bottomClockColor, readClock } from "./clocks";
import { approximateFen, placementFromDom, placementOf, replayMoves } from "./dom-fen";
import { type MoveList, readMoveList } from "./move-list";
import { pageKindFromPath } from "./page-kind";
import { queryAllSafe, queryFirst, queryFirstElement, querySafe } from "./query";
import { PROMOTION_ORDER, SELECTORS } from "./selectors";
import {
	checkBoardSanity,
	checkOrientation,
	checkPlacementConsistency,
	checkTurnConsistency,
	probeLadders,
} from "./self-check";

const S = SELECTORS;
const SITE: Site = "chesscom";
/**
 * Game id in a live game URL. chess.com serves live games at `/game/<digits>`
 * (owner's capture, 2026-09-09); `/game/live/<digits>` is the older form and
 * still appears in links. `/game/daily/<id>` and the archive's
 * `/games/view/<id>` deliberately do not match.
 */
const LIVE_ID_RE = /^\/game\/(?:live\/)?(\d+)/;
const RATING_RE = /(\d{3,4})/;

/** Ladders whose miss is a telemetry-worthy `selectorMiss` (the rest are situational). */
const REQUIRED: ReadonlySet<string> = new Set(["board", "moveList", "playerBottom"]);

const LADDERS: Record<string, readonly string[]> = {
	board: S.board,
	moveList: S.moveList,
	moveNode: S.moveNode,
	moveText: S.moveText,
	moveSelected: S.moveSelected,
	result: S.result,
	clockTime: S.clockTime,
	playerTop: S.playerTop,
	playerBottom: S.playerBottom,
	username: S.username,
	rating: S.rating,
	gameOver: S.gameOver,
	newGame: S.newGame,
	rematch: S.rematch,
	promotionWindow: S.promotionWindow,
	botCard: S.botCard,
};

/** Body-observer interest: board replacement, game-over modal, result row, promotion window. */
const RELEVANT = [
	...S.board,
	// the live page has no `wc-simple-move-list` until the first move is played
	...S.moveList,
	...S.gameOver,
	...S.result,
	...S.promotionWindow,
].join(",");

function squareFromClass(el: Element): Square | null {
	const m = S.squareRe.exec(el.getAttribute("class") ?? "");
	if (!m) return null;
	return squareOf(Number(m[1]) - 1, Number(m[2]) - 1);
}

function ratingFrom(text: string | null | undefined): number | null {
	const m = RATING_RE.exec(text ?? "");
	return m ? Number(m[1]) : null;
}

/**
 * Whether this board renders its pieces as DOM elements. chess.com ships two
 * renderers: `/play/computer` still lays out `.piece` divs, while the live board
 * draws into a `<canvas>` (WebGL) and has none. Behavioural, not class-based:
 * `board-webgl-2d` is a name chess.com may change, "no piece element" is not.
 */
function hasDomPieces(board: Element): boolean {
	return querySafe(board, S.piece) !== null;
}

function plyOf(list: MoveList): number {
	return list.selectedIndex >= 0 ? list.selectedIndex + 1 : list.sans.length;
}

export class ChessComAdapter extends AdapterBase implements SiteAdapter {
	readonly site = SITE;
	private observedBoard: Element | null = null;
	private observedMoveList: Element | null = null;

	constructor(options: AdapterOptions = {}) {
		super(options, TIMINGS.adapterDebounceMs, TIMINGS.adapterSelfCheckIntervalMs);
		this.start();
	}

	// ---- page / players ------------------------------------------------------------

	detectPageKind(): PageKind {
		const kind = pageKindFromPath(this.win.location.pathname);
		const mode = this.bridgeState?.mode;
		// The bridge mode only refines the live pages; puzzles/analysis/daily keep their URL kind.
		if (!mode || (kind !== "live-lobby" && kind !== "live-game")) return kind;
		if (mode === "playing" && bridgeColor(this.bridgeState?.playingAs) !== null) return "live-game";
		if (kind === "live-game" && (mode === "observing" || mode === "passive-observing"))
			return "live-spectate";
		if (mode === "analysis") return "analysis";
		return kind;
	}

	getOpponent(): Opponent | null {
		const kind = this.detectPageKind();
		const top = queryFirstElement(S.playerTop, this.doc);
		const topName = top ? queryFirstElement(S.username, top)?.textContent?.trim() : undefined;
		const topRating = top ? ratingFrom(queryFirstElement(S.rating, top)?.textContent) : null;
		const card = queryFirstElement(S.botCard, this.doc);
		const isBot = kind === "vs-computer" || card !== null;
		const name =
			topName || (card ? queryFirstElement(S.botName, card)?.textContent?.trim() : undefined) || "";
		const rating =
			topRating ?? (card ? ratingFrom(queryFirstElement(S.botRating, card)?.textContent) : null);
		if (!name && rating === null) return null;
		return { isBot, name, ratingEstimate: rating };
	}

	isReady(): boolean {
		return this.boardElement() !== null;
	}

	getMyColor(): Color | null {
		const s = this.bridgeState;
		if (s?.mode) {
			return s.mode === "playing" ? bridgeColor(s.playingAs) : null;
		}
		const kind = this.detectPageKind();
		if (kind !== "live-game" && kind !== "vs-computer" && kind !== "daily") return null;
		const playing = bridgeColor(s?.playingAs);
		if (playing) return playing;
		// The page shows my colour at the bottom unless the user turned the board round by hand,
		// which it does not report separately: the bottom colour is the best DOM answer there is.
		return this.bottomColor() ?? (this.isFlipped() ? "b" : "w");
	}

	// ---- position -----------------------------------------------------------------

	getPlacement(): string | null {
		const board = this.boardElement();
		return board ? placementFromDom(board) : null;
	}

	getPositionInfo(): PositionInfo | null {
		return this.positionInfoFor(this.getPlacement(), readMoveList(this.doc));
	}

	getSideToMove(): Color | null {
		return this.sideToMoveFor(this.getPlacement(), readMoveList(this.doc));
	}

	getClock(side: Color): ClockReading | null {
		return readClock(this.doc, side);
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

	/**
	 * "Black at the bottom", which is what `geometry.ts` means by `flipped`.
	 * chess.com's `getOptions().flipped` means exactly that — measured on live
	 * games: white is `playingAs 1 / flipped false`, black is
	 * `playingAs 2 / flipped true` — so the bridge value passes straight through
	 * (it is NOT "the user flipped it by hand", and combining it with
	 * `playingAs` would mirror every square when playing black).
	 *
	 * Without a bridge: the board's own `flipped` class (DOM renderer only — the
	 * WebGL board does not carry it even when black is at the bottom), then the
	 * colour the page shows at the bottom.
	 */
	isFlipped(): boolean {
		if (typeof this.bridgeState?.flipped === "boolean") return this.bridgeState.flipped;
		if (this.boardElement()?.classList.contains(S.boardFlippedClass) === true) return true;
		return this.bottomColor() === "b";
	}

	getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null {
		const win = queryFirstElement(S.promotionWindow, this.doc);
		if (!win) return null;
		const color: Color = this.getMyColor() ?? (dest.charAt(1) === "8" ? "w" : "b");
		const el =
			querySafe(win, S.promotionPiece(color, piece)) ??
			queryAllSafe(win, S.promotionPieceAny)[PROMOTION_ORDER.indexOf(piece)] ??
			null;
		if (!el) return null;
		const r = toRect(el.getBoundingClientRect());
		return r.width > 0 ? r : null;
	}

	// ---- actions ------------------------------------------------------------------

	/**
	 * Activates the site's own new-game / rematch button with `HTMLElement.click()`.
	 * This is a button activation the page offers to the user — not board input —
	 * and the one permitted synthetic action in the content script (§9.1, §13).
	 */
	tryStartNewGame(mode: NewGameMode): boolean {
		const ladder = mode === "rematch" ? S.rematch : S.newGame;
		for (const selector of ladder) {
			for (const el of queryAllSafe(this.doc, selector)) {
				const textOk =
					mode === "rematch" ||
					selector.includes("new-game") ||
					S.newGameTextRe.test(el.textContent ?? "");
				if (!textOk) continue;
				(el as HTMLElement).click();
				return true;
			}
		}
		return false;
	}

	probe(): ProbeReport {
		const ladder = probeLadders(LADDERS, this.doc);
		const board = this.boardElement();
		const placement = this.getPlacement();
		const list = readMoveList(this.doc);
		const replay = replayMoves(list.sans.slice(0, plyOf(list)));
		const bottom = this.bottomColor();
		const canvas = board !== null && !hasDomPieces(board);
		const info = this.positionInfoFor(placement, list);
		const checks = [
			checkBoardSanity(placement ?? (info ? placementOf(info.fen) : null)),
			canvas
				? { name: "placementConsistency", ok: true, detail: "canvas board (no DOM pieces)" }
				: checkPlacementConsistency(replay ? placementOf(replay.fen) : null, placement),
			checkTurnConsistency([
				{ name: "bridge", turn: this.bridgeTurn() },
				{ name: "clock", turn: activeClockColor(this.doc) },
				{ name: "parity", turn: this.parityTurn() },
			]),
			checkOrientation([
				{
					// the WebGL board never carries the class, so it is no evidence there
					name: "class",
					flipped: canvas ? null : (board?.classList.contains(S.boardFlippedClass) ?? null),
				},
				{
					name: "bridge",
					flipped: typeof this.bridgeState?.flipped === "boolean" ? this.bridgeState.flipped : null,
				},
				{ name: "bottomRow", flipped: bottom ? bottom === "b" : null },
			]),
			this.geometryCheck(),
			this.bridge
				? { name: "apiPresence", ok: this.readyBridge() !== null && this.bridgeState !== null }
				: { name: "apiPresence", ok: false, detail: "no bridge (DOM mode)" },
		];
		const report = {
			site: SITE,
			at: Date.now(),
			matched: ladder.matched,
			misses: ladder.misses,
			checks,
		};
		this.reportProbe(report, REQUIRED, []);
		return report;
	}

	// ---- AdapterBase hooks --------------------------------------------------------

	protected installObservers(): void {
		const board = this.boardElement();
		this.observedBoard = board;
		this.observedMoveList = this.moveListElement();
		this.observe(board, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "style"],
		});
		this.observe(this.observedMoveList, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		for (const clock of queryAllSafe(this.doc, S.clock))
			this.observe(clock, { attributes: true, attributeFilter: ["class"] });
		// SPA: board replacement, game-over modal, result row (filtered to those subtrees)
		this.observe(this.doc.body, { childList: true, subtree: true }, (records) =>
			this.touches(records, RELEVANT)
		);
		const onPop = (): void => this.schedule();
		this.win.addEventListener("popstate", onPop);
		this.addObserverDisposer(() => this.win.removeEventListener("popstate", onPop));
	}

	protected read(): AdapterReading | null {
		const board = this.boardElement();
		if (!board) return null;
		// the live page grows its move list after the first move; observe it when it appears
		if (board !== this.observedBoard || this.moveListElement() !== this.observedMoveList)
			this.reinstallObservers();
		const domPieces = hasDomPieces(board);
		// DOM renderer only: a `.piece.dragging` means the markup is mid-gesture. The WebGL board
		// has no piece element to drag, and `game.getFEN()` moves only on a completed move.
		if (domPieces && querySafe(board, S.dragging)) return null;
		const placement = this.getPlacement();
		const list = readMoveList(this.doc);
		const info = this.positionInfoFor(placement, list);
		// `positionInfoFor` is the position source (bridge → replay → DOM); the DOM placement is
		// only one of its inputs, and a WebGL board never has one.
		if (!info) return null;
		// A board that renders pieces but cannot be read is mid-animation: retry on the next record.
		if (domPieces && placement === null) return null;
		const sideToMove =
			this.sideToMoveFor(placement, list) ?? (info.fen.split(" ")[1] === "b" ? "b" : "w");
		const ply = plyOf(list);
		const replay = replayMoves(list.sans.slice(0, ply));
		const lastMove = replay?.lastMove ?? this.bridgeLastMove();
		const gameId = this.gameIdentity(ply);
		const snapshot: AdapterPositionSnapshot = {
			site: SITE,
			gameId,
			fen: info.fen,
			approximate: info.approximate,
			ply,
			sideToMove,
			myColor: this.getMyColor(),
			...(lastMove ? { lastMove } : {}),
			clocks: { w: this.clockState("w"), b: this.clockState("b") },
			capturedAt: Date.now(),
		};
		return {
			// Keyed off the position actually published: the DOM placement is `null` for the
			// whole of a WebGL game, which would dedupe every move away.
			key: `${placementOf(info.fen)}|${sideToMove}`,
			snapshot,
			gameOver: this.gameResultFor(list),
			gameKey: gameId,
		};
	}

	/**
	 * What `observeMove` compares. With no `.piece` elements the move list is the
	 * DOM evidence that a move landed, and its replay is the placement to check;
	 * the bridge cache is the last resort because an unsolicited page event can
	 * leave it one `getState` behind. `highlightSquares()` is empty on a WebGL
	 * board, so confirmation there rests on the move count.
	 */
	protected watchMove(): MoveWatch {
		const list = readMoveList(this.doc);
		const dom = this.getPlacement();
		return {
			placement: dom ?? this.placementWithoutPieces(list),
			moveCount: list.sans.length,
			lastMoveSquares: this.highlightSquares(),
		};
	}

	/** Placement of a board that renders no pieces: the move list's replay, else the bridge FEN. */
	private placementWithoutPieces(list: MoveList): string | null {
		const replay = this.hasMoveList() ? replayMoves(list.sans.slice(0, plyOf(list))) : null;
		if (replay) return placementOf(replay.fen);
		const fen = this.bridgeFen();
		return fen === null ? null : placementOf(fen);
	}

	protected drawPayload(
		highlights: Array<{ square: Square; color: string }>,
		arrows: Array<{ from: Square; to: Square; color: string }>
	): unknown {
		return { arrows, highlights };
	}

	protected clearPayload(): unknown {
		return { keys: [...this.highlightKeys] };
	}

	protected boardElement(): Element | null {
		return queryFirstElement(S.board, this.doc);
	}

	protected hasMoveList(): boolean {
		return this.moveListElement() !== null;
	}

	private moveListElement(): Element | null {
		return queryFirstElement(S.moveList, this.doc);
	}

	protected urlGameId(): string | null {
		return LIVE_ID_RE.exec(this.win.location.pathname)?.[1] ?? null;
	}

	// ---- private readers ----------------------------------------------------------

	/**
	 * Hybrid FEN (Appendix C §3): bridge → SAN replay → DOM placement with
	 * `approximate`. A WebGL board has no DOM placement at all, which is exactly
	 * what the first two sources are for.
	 */
	private positionInfoFor(placement: string | null, list: MoveList): PositionInfo | null {
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement))
			return { fen: fromBridge, approximate: false, source: "bridge" };
		const ply = plyOf(list);
		const replay = replayMoves(list.sans.slice(0, ply));
		// With no placement to corroborate it, a replay is evidence only when the move list
		// actually holds plies. Requiring merely that the list *element* exists would let an
		// empty one "prove" the start position on a mid-game canvas board during the window
		// before the bridge answers — publishing a confident wrong position, and now a
		// highlight on the wrong squares. A genuine ply-0 live game is answered by the bridge;
		// with no bridge and no plies, `null` (keep polling) is the honest reading.
		if (replay && (placement !== null ? placementOf(replay.fen) === placement : ply > 0))
			return { fen: replay.fen, approximate: false, source: "replay" };
		if (!placement) return null;
		const turn = this.sideToMoveFor(placement, list) ?? "w";
		const fen = approximateFen(placement, turn, {
			fullmove: Math.floor(ply / 2) + 1,
			...(this.lastMoveBetween(placement, this.highlightSquares()) ?? {}),
		});
		return { fen, approximate: true, source: "dom" };
	}

	/** Bridge FEN (when consistent with the DOM) → active clock → move-list parity. */
	private sideToMoveFor(placement: string | null, list: MoveList): Color | null {
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement)) {
			const turn = fromBridge.split(" ")[1];
			if (turn === "w" || turn === "b") return turn;
		}
		const clock = activeClockColor(this.doc);
		if (clock) return clock;
		if (!this.hasMoveList()) return null;
		return plyOf(list) % 2 === 0 ? "w" : "b";
	}

	/**
	 * The colour the page shows at the bottom: the bottom player panel's colour
	 * block, else the bottom clock's colour. The live (WebGL) layout's panel
	 * carries no colour class — its clocks do (owner's capture, 2026-09-09).
	 */
	private bottomColor(): Color | null {
		const bottom = queryFirstElement(S.playerBottom, this.doc);
		if (bottom) {
			if (querySafe(bottom, S.bottomColorClass.w)) return "w";
			if (querySafe(bottom, S.bottomColorClass.b)) return "b";
		}
		return bottomClockColor(this.doc);
	}

	private bridgeTurn(): Color | null {
		const fen = this.bridgeFen();
		const turn = fen?.split(" ")[1];
		if (turn === "w" || turn === "b") return turn;
		return bridgeColor(this.bridgeState?.turn);
	}

	private bridgeLastMove(): { from: Square; to: Square; san: string } | null {
		const lm = this.bridgeState?.lastMove;
		return lm ? { from: lm.from, to: lm.to, san: lm.san ?? "" } : null;
	}

	/** Squares of the `.highlight` elements (last move, unless a selection/premove is pending). */
	private highlightSquares(): Square[] {
		const board = this.boardElement();
		if (!board) return [];
		return queryAllSafe(board, S.highlight)
			.map(squareFromClass)
			.filter((s): s is Square => s !== null);
	}

	private gameResultFor(list: MoveList): GameResult | null {
		const s = this.bridgeState;
		if (s?.result && s.result !== "*") return this.parseResult(s.result);
		if (s?.gameOver) return this.parseResult(s.result) ?? "*";
		if (list.result) return list.result;
		const over = queryFirst(S.gameOver, this.doc)?.element;
		if (!over) return null;
		const header = querySafe(this.doc, S.gameOverHeader);
		const m = S.gameOverHeaderClassRe.exec(header?.getAttribute("class") ?? "");
		const me = this.getMyColor();
		switch (m?.[1]) {
			case "userWon":
				return me === "b" ? "0-1" : "1-0";
			case "userLost":
				return me === "b" ? "1-0" : "0-1";
			case "whiteWon":
				return "1-0";
			case "blackWon":
				return "0-1";
			case "draw":
				return "1/2-1/2";
			default:
				return "*";
		}
	}

	private parseResult(text: string | undefined): GameResult | null {
		if (text === "1-0" || text === "0-1" || text === "1/2-1/2") return text;
		return null;
	}
}

export function createChesscomAdapter(options: AdapterOptions = {}): SiteAdapter {
	return new ChessComAdapter(options);
}
