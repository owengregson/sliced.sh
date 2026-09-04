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
import { chesscomActiveClockColor, readChesscomClock } from "./clocks";
import { approximateFen, chesscomPlacementFromDom, placementOf, replayMoves } from "./dom-fen";
import { type ChesscomMoveList, readChesscomMoveList } from "./move-list";
import { detectChesscomPageKind } from "./page-kind";
import { queryAllSafe, queryFirst, queryFirstElement, querySafe } from "./query";
import { PROMOTION_ORDER, SELECTORS } from "./selectors";
import {
	checkBoardSanity,
	checkOrientation,
	checkPlacementConsistency,
	checkTurnConsistency,
	probeLadders,
} from "./self-check";

const C = SELECTORS.chesscom;
const SITE: Site = "chesscom";
const LIVE_ID_RE = /^\/game\/live\/(\d+)/;
const RATING_RE = /(\d{3,4})/;

/** Ladders whose miss is a telemetry-worthy `selectorMiss` (the rest are situational). */
const REQUIRED: ReadonlySet<string> = new Set(["board", "moveList", "playerBottom"]);

const LADDERS: Record<string, readonly string[]> = {
	board: C.board,
	moveList: C.moveList,
	moveNode: C.moveNode,
	moveText: C.moveText,
	moveSelected: C.moveSelected,
	result: C.result,
	clockTime: C.clockTime,
	playerTop: C.playerTop,
	playerBottom: C.playerBottom,
	username: C.username,
	rating: C.rating,
	gameOver: C.gameOver,
	newGame: C.newGame,
	rematch: C.rematch,
	promotionWindow: C.promotionWindow,
	botCard: C.botCard,
};

/** Body-observer interest: board replacement, game-over modal, result row, promotion window. */
const RELEVANT = [...C.board, ...C.gameOver, ...C.result, ...C.promotionWindow].join(",");

function squareFromClass(el: Element): Square | null {
	const m = C.squareRe.exec(el.getAttribute("class") ?? "");
	if (!m) return null;
	return squareOf(Number(m[1]) - 1, Number(m[2]) - 1);
}

function ratingFrom(text: string | null | undefined): number | null {
	const m = RATING_RE.exec(text ?? "");
	return m ? Number(m[1]) : null;
}

function plyOf(list: ChesscomMoveList): number {
	return list.selectedIndex >= 0 ? list.selectedIndex + 1 : list.sans.length;
}

export class ChessComAdapter extends AdapterBase implements SiteAdapter {
	readonly site = SITE;
	private observedBoard: Element | null = null;

	constructor(options: AdapterOptions = {}) {
		super(options, TIMINGS.adapterDebounceMs, TIMINGS.adapterSelfCheckIntervalMs);
		this.start();
	}

	// ---- page / players ------------------------------------------------------------

	detectPageKind(): PageKind {
		const kind = detectChesscomPageKind(this.win.location.pathname);
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
		const top = queryFirstElement(C.playerTop, this.doc);
		const topName = top ? queryFirstElement(C.username, top)?.textContent?.trim() : undefined;
		const topRating = top ? ratingFrom(queryFirstElement(C.rating, top)?.textContent) : null;
		const card = queryFirstElement(C.botCard, this.doc);
		const isBot = kind === "vs-computer" || card !== null;
		const name =
			topName || (card ? queryFirstElement(C.botName, card)?.textContent?.trim() : undefined) || "";
		const rating =
			topRating ?? (card ? ratingFrom(queryFirstElement(C.botRating, card)?.textContent) : null);
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
		const bottom = this.bottomColor();
		if (bottom) return bottom;
		return this.isFlipped() ? "b" : "w";
	}

	// ---- position -----------------------------------------------------------------

	getPlacement(): string | null {
		const board = this.boardElement();
		return board ? chesscomPlacementFromDom(board) : null;
	}

	getPositionInfo(): PositionInfo | null {
		return this.positionInfoFor(this.getPlacement(), readChesscomMoveList(this.doc));
	}

	getSideToMove(): Color | null {
		return this.sideToMoveFor(this.getPlacement(), readChesscomMoveList(this.doc));
	}

	getClock(side: Color): ClockReading | null {
		return readChesscomClock(this.doc, side);
	}

	getMoveList(): string[] {
		return readChesscomMoveList(this.doc).sans;
	}

	getPly(): number {
		return plyOf(readChesscomMoveList(this.doc));
	}

	isAtLivePosition(): boolean {
		const list = readChesscomMoveList(this.doc);
		return list.selectedIndex === -1 || list.selectedIndex === list.sans.length - 1;
	}

	isGameOver(): boolean {
		return this.gameResultFor(readChesscomMoveList(this.doc)) !== null;
	}

	// ---- geometry -----------------------------------------------------------------

	getBoardRect(): Rect | null {
		const board = this.boardElement();
		return board ? toRect(board.getBoundingClientRect()) : null;
	}

	isFlipped(): boolean {
		if (typeof this.bridgeState?.flipped === "boolean") return this.bridgeState.flipped;
		return this.boardElement()?.classList.contains(C.boardFlippedClass) ?? false;
	}

	getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null {
		const win = queryFirstElement(C.promotionWindow, this.doc);
		if (!win) return null;
		const color: Color = this.getMyColor() ?? (dest.charAt(1) === "8" ? "w" : "b");
		const el =
			querySafe(win, C.promotionPiece(color, piece)) ??
			queryAllSafe(win, C.promotionPieceAny)[PROMOTION_ORDER.indexOf(piece)] ??
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
		const ladder = mode === "rematch" ? C.rematch : C.newGame;
		for (const selector of ladder) {
			for (const el of queryAllSafe(this.doc, selector)) {
				const textOk =
					mode === "rematch" ||
					selector.includes("new-game") ||
					C.newGameTextRe.test(el.textContent ?? "");
				if (!textOk) continue;
				(el as HTMLElement).click();
				return true;
			}
		}
		return false;
	}

	probe(): ProbeReport {
		const ladder = probeLadders(LADDERS, this.doc);
		const placement = this.getPlacement();
		const list = readChesscomMoveList(this.doc);
		const replay = replayMoves(list.sans.slice(0, plyOf(list)));
		const bottom = this.bottomColor();
		const checks = [
			checkBoardSanity(placement),
			checkPlacementConsistency(replay ? placementOf(replay.fen) : null, placement),
			checkTurnConsistency([
				{ name: "bridge", turn: this.bridgeTurn() },
				{ name: "clock", turn: chesscomActiveClockColor(this.doc) },
				{ name: "parity", turn: this.parityTurn() },
			]),
			checkOrientation([
				{
					name: "class",
					flipped: this.boardElement()?.classList.contains(C.boardFlippedClass) ?? null,
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
		this.observe(board, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "style"],
		});
		this.observe(queryFirstElement(C.moveList, this.doc), {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		for (const clock of queryAllSafe(this.doc, C.clock))
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
		if (board !== this.observedBoard) this.reinstallObservers();
		if (querySafe(board, C.dragging)) return null;
		const placement = this.getPlacement();
		const list = readChesscomMoveList(this.doc);
		const info = this.positionInfoFor(placement, list);
		if (!info || !placement) return null;
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
			key: `${placement}|${sideToMove}`,
			snapshot,
			gameOver: this.gameResultFor(list),
			gameKey: gameId,
		};
	}

	protected watchMove(): MoveWatch {
		return {
			placement: this.getPlacement(),
			moveCount: readChesscomMoveList(this.doc).sans.length,
			lastMoveSquares: this.highlightSquares(),
		};
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
		return queryFirstElement(C.board, this.doc);
	}

	protected hasMoveList(): boolean {
		return queryFirstElement(C.moveList, this.doc) !== null;
	}

	protected urlGameId(): string | null {
		return LIVE_ID_RE.exec(this.win.location.pathname)?.[1] ?? null;
	}

	// ---- private readers ----------------------------------------------------------

	/** Hybrid FEN (Appendix C §3): bridge → SAN replay → DOM placement with `approximate`. */
	private positionInfoFor(placement: string | null, list: ChesscomMoveList): PositionInfo | null {
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement))
			return { fen: fromBridge, approximate: false, source: "bridge" };
		const ply = plyOf(list);
		const replay = replayMoves(list.sans.slice(0, ply));
		if (replay && (placement === null || placementOf(replay.fen) === placement))
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
	private sideToMoveFor(placement: string | null, list: ChesscomMoveList): Color | null {
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement)) {
			const turn = fromBridge.split(" ")[1];
			if (turn === "w" || turn === "b") return turn;
		}
		const clock = chesscomActiveClockColor(this.doc);
		if (clock) return clock;
		if (!this.hasMoveList()) return null;
		return plyOf(list) % 2 === 0 ? "w" : "b";
	}

	private bottomColor(): Color | null {
		const bottom = queryFirstElement(C.playerBottom, this.doc);
		if (!bottom) return null;
		if (querySafe(bottom, C.bottomColorClass.w)) return "w";
		if (querySafe(bottom, C.bottomColorClass.b)) return "b";
		return null;
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
		return queryAllSafe(board, C.highlight)
			.map(squareFromClass)
			.filter((s): s is Square => s !== null);
	}

	private gameResultFor(list: ChesscomMoveList): GameResult | null {
		const s = this.bridgeState;
		if (s?.result && s.result !== "*") return this.parseResult(s.result);
		if (s?.gameOver) return this.parseResult(s.result) ?? "*";
		if (list.result) return list.result;
		const over = queryFirst(C.gameOver, this.doc)?.element;
		if (!over) return null;
		const header = querySafe(this.doc, C.gameOverHeader);
		const m = C.gameOverHeaderClassRe.exec(header?.getAttribute("class") ?? "");
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
