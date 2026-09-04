/**
 * chess.com adapter (Appendix C §1, §3.4a). ISOLATED world: DOM readers
 * everywhere, the MAIN-world bridge (Task 21) preferred for FEN / turn /
 * colour / mode and for native markings when it is available.
 */

import { squareOf } from "@core/chess/squares";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
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
import { readChesscomMoveList } from "./move-list";
import { detectChesscomPageKind } from "./page-kind";
import { queryAllSafe, queryFirst, queryFirstElement, querySafe } from "./query";
import { SELECTORS } from "./selectors";
import {
	checkBoardSanity,
	checkGeometry,
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
const REQUIRED = new Set(["board", "moveList", "playerBottom"]);

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

function squareFromClass(el: Element): Square | null {
	const m = C.squareRe.exec(el.getAttribute("class") ?? "");
	if (!m) return null;
	return squareOf(Number(m[1]) - 1, Number(m[2]) - 1);
}

function ratingFrom(text: string | null | undefined): number | null {
	const m = RATING_RE.exec(text ?? "");
	return m ? Number(m[1]) : null;
}

export class ChessComAdapter extends AdapterBase implements SiteAdapter {
	readonly site = SITE;
	private gameSerial = 0;
	private lastBoard: Element | null = null;

	constructor(options: AdapterOptions = {}) {
		super(options, TIMINGS.adapterDebounceMs, TIMINGS.adapterSelfCheckIntervalMs);
		this.start();
	}

	// ---- page / players ------------------------------------------------------------

	detectPageKind(): PageKind {
		const kind = detectChesscomPageKind(this.win.location.pathname);
		const mode = this.bridgeState?.mode;
		if (!mode) return kind;
		if (kind === "vs-computer") return kind;
		if (mode === "playing" && bridgeColor(this.bridgeState?.playingAs) !== null) return "live-game";
		if (kind === "live-game" && (mode === "observing" || mode === "passive-observing"))
			return "live-spectate";
		if (mode === "analysis" && kind !== "puzzles" && kind !== "daily") return "analysis";
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
		return this.board() !== null;
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
		const board = this.board();
		return board ? chesscomPlacementFromDom(board) : null;
	}

	getPositionInfo(): PositionInfo | null {
		const placement = this.getPlacement();
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement))
			return { fen: fromBridge, approximate: false, source: "bridge" };
		const list = readChesscomMoveList(this.doc);
		const ply = this.plyOf(list.sans.length, list.selectedIndex);
		const replay = replayMoves(list.sans.slice(0, ply));
		if (replay && (placement === null || placementOf(replay.fen) === placement))
			return { fen: replay.fen, approximate: false, source: "replay" };
		if (!placement) return null;
		const turn = this.getSideToMove() ?? "w";
		const fen = approximateFen(placement, turn, {
			fullmove: Math.floor(ply / 2) + 1,
			...(this.lastMoveFromHighlights(placement) ?? {}),
		});
		return { fen, approximate: true, source: "dom" };
	}

	getSideToMove(): Color | null {
		const fromBridge = this.bridgeFen();
		const placement = this.getPlacement();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement)) {
			const turn = fromBridge.split(" ")[1];
			if (turn === "w" || turn === "b") return turn;
		}
		const clock = chesscomActiveClockColor(this.doc);
		if (clock) return clock;
		return this.parityTurn();
	}

	getClock(side: Color): ClockReading | null {
		return readChesscomClock(this.doc, side);
	}

	getMoveList(): string[] {
		return readChesscomMoveList(this.doc).sans;
	}

	getPly(): number {
		const list = readChesscomMoveList(this.doc);
		return this.plyOf(list.sans.length, list.selectedIndex);
	}

	isAtLivePosition(): boolean {
		const list = readChesscomMoveList(this.doc);
		return list.selectedIndex === -1 || list.selectedIndex === list.sans.length - 1;
	}

	isGameOver(): boolean {
		return this.gameResult() !== null;
	}

	// ---- geometry -----------------------------------------------------------------

	getBoardRect(): Rect | null {
		const board = this.board();
		return board ? toRect(board.getBoundingClientRect()) : null;
	}

	isFlipped(): boolean {
		if (typeof this.bridgeState?.flipped === "boolean") return this.bridgeState.flipped;
		return this.board()?.classList.contains(C.boardFlippedClass) ?? false;
	}

	getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null {
		const win = queryFirstElement(C.promotionWindow, this.doc);
		if (!win) return null;
		const color: Color = this.getMyColor() ?? (dest.charAt(1) === "8" ? "w" : "b");
		let el = querySafe(win, C.promotionPiece(color, piece));
		if (!el) {
			const order: PromoPiece[] = ["q", "n", "r", "b"];
			el = queryAllSafe(win, C.promotionPieceAny)[order.indexOf(piece)] ?? null;
		}
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
		for (const concern of ladder.misses)
			if (REQUIRED.has(concern)) log.warn("adapter.selectorMiss", { site: SITE, concern });
		const placement = this.getPlacement();
		const list = readChesscomMoveList(this.doc);
		const replay = replayMoves(list.sans.slice(0, this.plyOf(list.sans.length, list.selectedIndex)));
		const checks = [
			checkBoardSanity(placement),
			checkPlacementConsistency(replay ? placementOf(replay.fen) : null, placement),
			checkTurnConsistency([
				{ name: "bridge", turn: this.bridgeTurn() },
				{ name: "clock", turn: chesscomActiveClockColor(this.doc) },
				{ name: "parity", turn: this.parityTurn() },
			]),
			checkOrientation([
				{ name: "class", flipped: this.board()?.classList.contains(C.boardFlippedClass) ?? null },
				{
					name: "bridge",
					flipped: typeof this.bridgeState?.flipped === "boolean" ? this.bridgeState.flipped : null,
				},
				{ name: "bottomRow", flipped: this.bottomColor() ? this.bottomColor() === "b" : null },
			]),
			this.geometryCheck(),
			this.bridge
				? { name: "apiPresence", ok: this.bridgeState !== null }
				: { name: "apiPresence", ok: false, detail: "no bridge (DOM mode)" },
		];
		return { site: SITE, at: Date.now(), matched: ladder.matched, misses: ladder.misses, checks };
	}

	// ---- AdapterBase hooks --------------------------------------------------------

	protected installObservers(): void {
		const board = this.board();
		this.lastBoard = board;
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
			records.some((r) =>
				[...r.addedNodes, ...r.removedNodes].some(
					(n) => n.nodeType === 1 && this.relevant(n as Element)
				)
			)
		);
		const onPop = (): void => this.schedule();
		this.win.addEventListener("popstate", onPop);
		this.addDisposer(() => this.win.removeEventListener("popstate", onPop));
	}

	protected read(): AdapterReading | null {
		const board = this.board();
		if (!board) return null;
		if (board !== this.lastBoard) {
			this.lastBoard = board;
			this.gameSerial++;
			this.installObservers();
		}
		if (querySafe(board, C.dragging)) return null;
		const info = this.getPositionInfo();
		const placement = this.getPlacement();
		if (!info || !placement) return null;
		const sideToMove = this.getSideToMove() ?? (info.fen.split(" ")[1] === "b" ? "b" : "w");
		const list = readChesscomMoveList(this.doc);
		const ply = this.plyOf(list.sans.length, list.selectedIndex);
		const replay = replayMoves(list.sans.slice(0, ply));
		const lastMove = replay?.lastMove ?? this.bridgeLastMove();
		const gameOver = this.gameResult();
		const snapshot: AdapterPositionSnapshot = {
			site: SITE,
			gameId: this.gameId(),
			fen: info.fen,
			approximate: info.approximate,
			ply,
			sideToMove,
			myColor: this.getMyColor(),
			...(lastMove ? { lastMove } : {}),
			clocks: {
				w: this.clockState("w"),
				b: this.clockState("b"),
			},
			capturedAt: Date.now(),
		};
		return {
			key: `${placement}|${sideToMove}`,
			snapshot,
			gameOver,
			gameKey: `${this.gameId()}|${ply <= 1 && list.sans.length <= 1 ? "fresh" : "live"}`,
		};
	}

	protected watchMove(): MoveWatch {
		const board = this.board();
		const squares: Square[] = [];
		if (board)
			for (const h of queryAllSafe(board, C.highlight)) {
				const sq = squareFromClass(h);
				if (sq) squares.push(sq);
			}
		return {
			placement: this.getPlacement(),
			moveCount: readChesscomMoveList(this.doc).sans.length,
			lastMoveSquares: squares,
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

	// ---- private readers ----------------------------------------------------------

	private board(): Element | null {
		return queryFirstElement(C.board, this.doc);
	}

	private relevant(el: Element): boolean {
		const sel = [...C.board, ...C.gameOver, ...C.result, ...C.promotionWindow].join(",");
		try {
			return el.matches(sel) || el.querySelector(sel) !== null;
		} catch {
			return false;
		}
	}

	private bottomColor(): Color | null {
		const bottom = queryFirstElement(C.playerBottom, this.doc);
		if (!bottom) return null;
		if (querySafe(bottom, C.bottomColorClass.w)) return "w";
		if (querySafe(bottom, C.bottomColorClass.b)) return "b";
		return null;
	}

	private plyOf(count: number, selectedIndex: number): number {
		return selectedIndex >= 0 ? selectedIndex + 1 : count;
	}

	private parityTurn(): Color | null {
		const list = readChesscomMoveList(this.doc);
		if (list.sans.length === 0 && !queryFirstElement(C.moveList, this.doc)) return null;
		const ply = this.plyOf(list.sans.length, list.selectedIndex);
		return ply % 2 === 0 ? "w" : "b";
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

	private lastMoveFromHighlights(
		placement: string
	): { lastMove: { from: Square; to: Square } } | null {
		const board = this.board();
		if (!board) return null;
		const squares = queryAllSafe(board, C.highlight)
			.map(squareFromClass)
			.filter((s): s is Square => s !== null);
		if (squares.length !== 2) return null;
		const [a, b] = squares as [Square, Square];
		const occupied = (sq: Square): boolean => {
			const rows = placement.split("/");
			const row = rows[8 - Number(sq.charAt(1))] ?? "";
			let file = 0;
			for (const ch of row) {
				if (/\d/.test(ch)) file += Number(ch);
				else {
					if (file === sq.charCodeAt(0) - 97) return true;
					file++;
				}
			}
			return false;
		};
		return occupied(b) && !occupied(a)
			? { lastMove: { from: a, to: b } }
			: occupied(a) && !occupied(b)
				? { lastMove: { from: b, to: a } }
				: null;
	}

	private gameResult(): GameResult | null {
		const s = this.bridgeState;
		if (s?.result && s.result !== "*") return this.parseResult(s.result);
		if (s?.gameOver) return this.parseResult(s.result) ?? "*";
		const list = readChesscomMoveList(this.doc);
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

	private clockState(side: Color): { ms: number; running: boolean } {
		const c = this.getClock(side);
		return c ? { ms: c.ms, running: c.running } : { ms: 0, running: false };
	}

	private gameId(): string {
		const m = LIVE_ID_RE.exec(this.win.location.pathname);
		if (m?.[1]) return m[1];
		return `${this.win.location.pathname.replace(/\W+/g, "-")}#${this.gameSerial}`;
	}

	private geometryCheck(): ReturnType<typeof checkGeometry> {
		const board = this.board();
		const rect = this.getBoardRect();
		if (!board || !rect) return { name: "geometry", ok: false, detail: "no board" };
		return checkGeometry(board, rect, this.isFlipped(), this.doc);
	}
}

export function createChesscomAdapter(options: AdapterOptions = {}): SiteAdapter {
	return new ChessComAdapter(options);
}
