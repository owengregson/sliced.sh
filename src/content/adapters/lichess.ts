/**
 * lichess adapter (Appendix C §2, §3.4a). Round pages expose no board API, so
 * everything is DOM: chessground transforms → placement, the structural
 * move-list detector → SAN replay, `.rclock.running` → turn. The bridge (Task
 * 21) supplies `ply` events, the analysis FEN, and the highlight overlay.
 */

import { fileOf, squareOf } from "@core/chess/squares";
import { TIMINGS } from "@core/constants/timings";
import type { Color, GameResult, PageKind, PromoPiece, Site, Square } from "@typedefs/game";
import {
	AdapterBase,
	type AdapterOptions,
	type AdapterPositionSnapshot,
	type AdapterReading,
	type ClockReading,
	type MoveWatch,
	type NewGameMode,
	type Opponent,
	type PositionInfo,
	type ProbeReport,
	type Rect,
	type SelfCheckResult,
	type SiteAdapter,
	toRect,
} from "./adapter";
import { lichessRunningClockColor, readLichessClock } from "./clocks";
import { approximateFen, lichessPlacementFromDom, placementOf, replayMoves } from "./dom-fen";
import { findLichessRoundMoves, type LichessMoveList, readLichessMoveList } from "./move-list";
import { detectLichessPageKind } from "./page-kind";
import { queryAllSafe, queryFirst, queryFirstElement, querySafe } from "./query";
import { LICHESS_AI_ELO, PROMOTION_ORDER, SELECTORS } from "./selectors";
import {
	checkBoardSanity,
	checkOrientation,
	checkPlacementConsistency,
	checkTurnConsistency,
	probeLadders,
} from "./self-check";

const L = SELECTORS.lichess;
const SITE: Site = "lichess";
const GAME_ID_RE = /^\/([a-zA-Z0-9]{8})/;
const REQUIRED: ReadonlySet<string> = new Set(["wrap"]);

const LADDERS: Record<string, readonly string[]> = {
	wrap: L.wrap,
	moves: L.moves,
	move: L.move,
	index: L.index,
	active: L.active,
	result: L.result,
	rematch: L.rematch,
	newOpponent: L.newOpponent,
};

/** Body-observer interest: promotion dialog, result, follow-up buttons, round app / board replacement. */
const RELEVANT = [L.promotion, ...L.result, L.followUp, L.roundApp, L.board].join(",");

function listPly(list: LichessMoveList): number {
	return list.activeIndex >= 0 ? list.activeIndex + 1 : list.sans.length;
}

export class LichessAdapter extends AdapterBase implements SiteAdapter {
	readonly site = SITE;
	private observedWrap: Element | null = null;
	private observedMoves: Element | null = null;

	constructor(options: AdapterOptions = {}) {
		super(options, TIMINGS.adapterDebounceMs, TIMINGS.adapterSelfCheckIntervalMs);
		this.start();
	}

	// ---- page / players ------------------------------------------------------------

	detectPageKind(): PageKind {
		const kind = detectLichessPageKind(this.win.location.pathname, this.doc);
		if (kind === "live-game" && this.aiLevel() !== null) return "vs-computer";
		return kind;
	}

	getOpponent(): Opponent | null {
		const top = querySafe(this.doc, L.playerTop);
		if (!top) return null;
		const name = querySafe(top, L.playerName)?.textContent?.trim() ?? "";
		const level = this.aiLevel();
		if (level !== null) return { isBot: true, name, ratingEstimate: LICHESS_AI_ELO[level] ?? null };
		const rating = Number(querySafe(top, L.playerRating)?.textContent?.replace(/\D/g, "") ?? "");
		return { isBot: false, name, ratingEstimate: rating > 0 ? rating : null };
	}

	isReady(): boolean {
		return this.boardElement() !== null;
	}

	getMyColor(): Color | null {
		const wrap = this.wrap();
		const body = this.doc.body as HTMLElement | null;
		if (!wrap || !body) return null;
		if (!body.classList.contains(L.bodyPlayingClass) || !wrap.classList.contains(L.manipulable))
			return null;
		return wrap.classList.contains(L.orientationBlack) ? "b" : "w";
	}

	// ---- position -----------------------------------------------------------------

	getPlacement(): string | null {
		const board = this.boardElement();
		if (!board) return null;
		const size = board.getBoundingClientRect().width || this.styledSize();
		return lichessPlacementFromDom(board, size > 0 ? size : undefined);
	}

	getPositionInfo(): PositionInfo | null {
		return this.positionInfoFor(this.getPlacement(), readLichessMoveList(this.doc));
	}

	getSideToMove(): Color | null {
		return this.sideToMoveFor(this.getPlacement(), readLichessMoveList(this.doc));
	}

	getClock(side: Color): ClockReading | null {
		return readLichessClock(this.doc, side);
	}

	getMoveList(): string[] {
		return readLichessMoveList(this.doc).sans;
	}

	getPly(): number {
		const list = readLichessMoveList(this.doc);
		return list.firstPly + listPly(list);
	}

	isAtLivePosition(): boolean {
		const list = readLichessMoveList(this.doc);
		return list.activeIndex === -1 || list.activeIndex === list.sans.length - 1;
	}

	isGameOver(): boolean {
		return this.gameResultFor(readLichessMoveList(this.doc)) !== null;
	}

	// ---- geometry -----------------------------------------------------------------

	getBoardRect(): Rect | null {
		const board = this.boardElement();
		return board ? toRect(board.getBoundingClientRect()) : null;
	}

	isFlipped(): boolean {
		return this.wrap()?.classList.contains(L.orientationBlack) ?? false;
	}

	getPromotionTargetRect(dest: Square, piece: PromoPiece): Rect | null {
		const dialog = querySafe(this.doc, L.promotion);
		if (!dialog) return null;
		const index = PROMOTION_ORDER.indexOf(piece);
		const square = queryAllSafe(dialog, L.promotionSquare)[index];
		if (!square) return null;
		const own = toRect(square.getBoundingClientRect());
		if (own.width > 0) return own;
		// No layout information: derive from the board (promotion.ts: left = file·12.5 %, top = i·12.5 %).
		const rect = this.getBoardRect();
		if (!rect || !(rect.width > 0)) return null;
		const s = rect.width / 8;
		const flipped = this.isFlipped();
		const col = flipped ? 7 - fileOf(dest) : fileOf(dest);
		const white = dest.charAt(1) === "8";
		const row = white !== flipped ? index : 7 - index;
		return toRect({ x: rect.left + col * s, y: rect.top + row * s, width: s, height: s });
	}

	// ---- actions ------------------------------------------------------------------

	/**
	 * Activates lila's own follow-up button with `HTMLElement.click()` (snabbdom
	 * `bind("click")`, no isTrusted check). A button activation offered to the
	 * user, not board input — the one permitted synthetic action here (§9.1, §13).
	 */
	tryStartNewGame(mode: NewGameMode): boolean {
		const ladder = mode === "rematch" ? L.rematch : L.newOpponent;
		const el = queryFirstElement(ladder, this.doc);
		if (!el) return false;
		(el as HTMLElement).click();
		return true;
	}

	probe(): ProbeReport {
		const ladder = probeLadders(LADDERS, this.doc);
		const placement = this.getPlacement();
		const list = readLichessMoveList(this.doc);
		const replay = list.firstPly === 0 ? replayMoves(list.sans.slice(0, listPly(list))) : null;
		const found = findLichessRoundMoves(this.doc);
		const ladderMoves = ladder.matched.some((m) => m.concern === "moves");
		const warnings: string[] = [];
		let tagRotation: SelfCheckResult;
		if (found && !ladderMoves) {
			const detail = `${found.moveTag}/${found.indexTag}`;
			warnings.push(`lichess rotated round tags to ${detail}`);
			tagRotation = { name: "tagRotation", ok: true, detail };
		} else if (found) tagRotation = { name: "tagRotation", ok: true, detail: "registry" };
		else tagRotation = { name: "tagRotation", ok: false, detail: "no moves container" };
		const wrap = this.wrap();
		const bottomClock = querySafe(this.doc, L.clockBottom);
		const checks = [
			checkBoardSanity(placement),
			checkPlacementConsistency(replay ? placementOf(replay.fen) : null, placement),
			checkTurnConsistency([
				{ name: "clock", turn: lichessRunningClockColor(this.doc) },
				{ name: "parity", turn: this.parityTurn() },
			]),
			checkOrientation([
				{ name: "wrap", flipped: wrap ? wrap.classList.contains(L.orientationBlack) : null },
				{
					name: "coords",
					flipped: wrap?.querySelector(L.coordsFilesBlack)
						? true
						: wrap?.querySelector(L.container)?.querySelector(L.coordsFiles)
							? false
							: null,
				},
				{
					name: "bottomClock",
					flipped: bottomClock
						? bottomClock.matches(L.clockColor.b)
							? true
							: bottomClock.matches(L.clockColor.w)
								? false
								: null
						: null,
				},
			]),
			this.geometryCheck(),
			tagRotation,
		];
		const report = {
			site: SITE,
			at: Date.now(),
			matched: ladder.matched,
			misses: ladder.misses,
			checks,
		};
		this.reportProbe(report, REQUIRED, warnings);
		return report;
	}

	// ---- AdapterBase hooks --------------------------------------------------------

	protected installObservers(): void {
		const board = this.boardElement();
		const wrap = this.wrap();
		this.observedWrap = wrap;
		this.observe(board, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["style", "class"],
		});
		this.observe(wrap, { attributes: true, attributeFilter: ["class"] });
		for (const clock of queryAllSafe(this.doc, L.clock))
			this.observe(clock, { attributes: true, attributeFilter: ["class"] });
		const moves = findLichessRoundMoves(this.doc);
		this.observedMoves = moves?.container ?? null;
		this.observe(moves?.container ?? null, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		// promotion dialog, result, follow-up buttons, round app replacement (rematch redirect)
		this.observe(this.doc.body, { childList: true, subtree: true }, (records) =>
			this.touches(records, RELEVANT)
		);
	}

	protected read(): AdapterReading | null {
		const board = this.boardElement();
		const wrap = this.wrap();
		if (!board || !wrap) return null;
		const moves = findLichessRoundMoves(this.doc);
		if (wrap !== this.observedWrap || (moves && moves.container !== this.observedMoves))
			this.reinstallObservers();
		if (querySafe(board, L.anim) || querySafe(board, L.dragging)) return null;
		if (querySafe(this.doc, L.promotion)) return null;
		const placement = this.getPlacement();
		const list = readLichessMoveList(this.doc);
		const info = this.positionInfoFor(placement, list);
		if (!info || !placement) return null;
		const sideToMove =
			this.sideToMoveFor(placement, list) ?? (info.fen.split(" ")[1] === "b" ? "b" : "w");
		const ply = list.firstPly + listPly(list);
		const replay = list.firstPly === 0 ? replayMoves(list.sans.slice(0, listPly(list))) : null;
		const lastMove = replay?.lastMove ?? null;
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
			moveCount: readLichessMoveList(this.doc).sans.length,
			lastMoveSquares: this.lastMoveSquares(),
		};
	}

	protected drawPayload(
		highlights: Array<{ square: Square; color: string }>,
		arrows: Array<{ from: Square; to: Square; color: string }>
	): unknown {
		return { orientation: this.isFlipped() ? "black" : "white", highlights, arrows };
	}

	protected clearPayload(): unknown {
		return undefined;
	}

	protected boardElement(): Element | null {
		const wrap = this.wrap();
		return wrap ? querySafe(wrap, L.board) : null;
	}

	protected hasMoveList(): boolean {
		return findLichessRoundMoves(this.doc) !== null;
	}

	protected urlGameId(): string | null {
		return GAME_ID_RE.exec(this.win.location.pathname)?.[1] ?? null;
	}

	// ---- private readers ----------------------------------------------------------

	private wrap(): Element | null {
		return queryFirstElement(L.wrap, this.doc);
	}

	/** Hybrid FEN (Appendix C §3): bridge → SAN replay (games from the start) → DOM + `approximate`. */
	private positionInfoFor(placement: string | null, list: LichessMoveList): PositionInfo | null {
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement))
			return { fen: fromBridge, approximate: false, source: "bridge" };
		const replay = list.firstPly === 0 ? replayMoves(list.sans.slice(0, listPly(list))) : null;
		if (replay && (placement === null || placementOf(replay.fen) === placement))
			return { fen: replay.fen, approximate: false, source: "replay" };
		if (!placement) return null;
		const ply = list.firstPly + listPly(list);
		const turn = this.sideToMoveFor(placement, list) ?? (ply % 2 === 0 ? "w" : "b");
		const fen = approximateFen(placement, turn, {
			fullmove: Math.floor(ply / 2) + 1,
			...(this.lastMoveBetween(placement, this.lastMoveSquares()) ?? {}),
		});
		return { fen, approximate: true, source: "dom" };
	}

	/** Bridge FEN (when consistent with the DOM) → running clock → move-list parity. */
	private sideToMoveFor(placement: string | null, list: LichessMoveList): Color | null {
		const fromBridge = this.bridgeFen();
		if (fromBridge && (placement === null || placementOf(fromBridge) === placement)) {
			const turn = fromBridge.split(" ")[1];
			if (turn === "w" || turn === "b") return turn;
		}
		const clock = lichessRunningClockColor(this.doc);
		if (clock) return clock;
		if (!this.hasMoveList()) return null;
		return (list.firstPly + listPly(list)) % 2 === 0 ? "w" : "b";
	}

	private aiLevel(): number | null {
		const top = querySafe(this.doc, L.playerTop);
		const m = L.aiNameRe.exec(top?.textContent ?? "");
		return m ? Number(m[1]) : null;
	}

	/** Squares of `square.last-move` (orientation-aware transforms). */
	private lastMoveSquares(): Square[] {
		const board = this.boardElement();
		if (!board) return [];
		const size = board.getBoundingClientRect().width || this.styledSize();
		if (!(size > 0)) return [];
		const s = size / 8;
		const flipped = this.isFlipped();
		const out: Square[] = [];
		for (const el of queryAllSafe(board, L.lastMove)) {
			const m = L.translateRe.exec(
				(el as HTMLElement).style?.transform || el.getAttribute("style") || ""
			);
			if (!m) continue;
			let col = Math.round(Number(m[1]) / s);
			let row = Math.round(Number(m[2]) / s);
			if (flipped) {
				col = 7 - col;
				row = 7 - row;
			}
			const sq = squareOf(col, 7 - row);
			if (sq) out.push(sq);
		}
		return out;
	}

	/** `cg-container`'s inline width, for boards that have no layout (tests). */
	private styledSize(): number {
		const container = this.boardElement()?.parentElement as HTMLElement | null;
		return Number.parseFloat(container?.style?.width ?? "") || 0;
	}

	private gameResultFor(list: LichessMoveList): GameResult | null {
		if (list.result) return list.result;
		if (queryFirst(L.result, this.doc) || querySafe(this.doc, L.followUp)) return "*";
		return null;
	}
}

export function createLichessAdapter(options: AdapterOptions = {}): SiteAdapter {
	return new LichessAdapter(options);
}
