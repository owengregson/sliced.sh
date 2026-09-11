/**
 * chess.com adapter (Appendix C §1, §3.4a). ISOLATED world: DOM readers
 * everywhere, the MAIN-world bridge (Task 21) preferred for FEN / turn /
 * colour / mode and for native markings when it is available.
 */

import { turnFieldOf } from "@core/chess/fen";
import { squareOf } from "@core/chess/squares";
import type { NewGameTargetResult } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
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
	bridgeColor,
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
import { activeClockColor, bottomClockColor, readClock } from "./clocks";
import { approximateFen, placementFromDom, placementOf, replayMoves } from "./dom-fen";
import { type MoveList, readMoveList } from "./move-list";
import { newGameControl, newGameSearchActive } from "./new-game";
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
import { timeControlFromBridge } from "./time-control";

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
	private restartControl: HTMLElement | null = null;
	private restartTargetId = "";
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
		// The bridge has spoken about the board's mode, so the ladder ends at the site's own
		// `getPlayingAs()`, whatever the mode is *called*.
		//
		// It is the one reading only a **player** has: a spectator's board answers nothing, and so
		// does a board in a mode we cannot read. Both halves matter.
		//   - `"playing"` with a colour is the answer, and with no colour the honest `null` — as
		//     before.
		//   - A mode name we do not hard-code (chess.com is free to rename or add one) no longer
		//     returns `null` on its own: `mayActOn` holds on a null colour with nothing to release it,
		//     so one renamed mode would strand a live game colourless for its whole length. But it
		//     must not reach the *render* either (below), because the bottom of the board is something
		//     a spectator has just as much as a player — that would hand the owner the bottom
		//     player's colour for a game they are only watching.
		//   - `"observing"` / `"analysis"` during a game of our own — the brief's stranding case — is
		//     the same rung: `getPlayingAs()` still names our colour there, and a real spectator's
		//     board still does not.
		if (s?.mode !== undefined) return bridgeColor(s.playingAs);
		// No mode at all: the live page's first second, before the bridge has answered anything, which
		// is the case the DOM ladder below exists for.
		const kind = this.detectPageKind();
		if (kind !== "live-game" && kind !== "vs-computer" && kind !== "daily") return null;
		const playing = bridgeColor(s?.playingAs);
		if (playing) return playing;
		// The page shows my colour at the bottom unless the user turned the board round by hand,
		// which it does not report separately: the bottom colour is the best DOM answer there is.
		//
		// And when there is none — the bridge has not answered AND the clocks have not rendered,
		// which is the live page's first second (owner's live test, 2026-09-09) — the answer is
		// `null`, never a guess. `isFlipped()` would have said "white at the bottom" by default and
		// the session would have predicted, highlighted and played the *opponent's* moves; a
		// session that holds until the colour is known predicts nothing instead, which is strictly
		// better. The bridge fills this in a moment later (`getPlayingAs()`); the reading is then
		// republished because `AdapterBase.apply` treats `null → known` on the game it is already
		// following as a change worth delivering — the dedupe key below is the position alone — and
		// `GameSession`'s own feed key carries `myColor` so the republish is not taken for the
		// reconnect replay.
		return this.bottomColor();
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

	/**
	 * The game's time control as the site reports it (§4.3). The MAIN-world bridge is the only
	 * source: `game.timeControl.get()`. There is no DOM fallback — the live page's header shows a
	 * formatted label, not the pair, and `game.times` / `game.timestamps` are both `{}` — so a
	 * game whose bridge never answers runs untimed, which is what the timing model's clockless
	 * branch is for.
	 */
	getTimeControl(): TimeControl | null {
		// The clocks are the unit cross-check (§4.3): a no-increment base a credible page clock exceeds a hundredfold is
		// not in milliseconds. Both sides come from the same reading, so the two cannot disagree.
		const hint = Math.max(this.clockState("w").ms, this.clockState("b").ms);
		return timeControlFromBridge(this.bridgeState?.timeControl, hint);
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
	 * Without that flag: the board's own `flipped` class (DOM renderer only — the
	 * WebGL board does not carry it even when black is at the bottom), then the
	 * colour *we* are playing, whatever supplied it.
	 *
	 * That last rung is not redundant with the first. `getFEN`, `getPlayingAs` and
	 * `getOptions().flipped` are three independent `safe(...)` reads of the same
	 * page object in the bridge, so `getOptions()` throwing while `getPlayingAs()`
	 * answers leaves the colour known and the flag absent — and since chess.com's
	 * `flipped` already folds the colour in (playing black *is* black at the
	 * bottom), the colour is the right answer there. Defaulting to white at the
	 * bottom instead would mirror every square for the side playing black, for the
	 * mark and for the hand alike.
	 *
	 * `false` only when nothing at all is known; nothing is planned, drawn or
	 * dispatched in that state (`GameSession.mayActOn`).
	 */
	isFlipped(): boolean {
		if (typeof this.bridgeState?.flipped === "boolean") return this.bridgeState.flipped;
		if (this.boardElement()?.classList.contains(S.boardFlippedClass) === true) return true;
		// `bottomColor()` is render-truthful — it reads whichever colour the page actually shows at
		// the bottom (the player block, else the bottom clock), so it tracks a board the owner has
		// turned round by hand. The colour does not: `playingAs` says which side we are, not which
		// way the board faces. So ask the render first and fall back to the colour only when the
		// page shows nothing, otherwise a hand flip during a partial bridge failure (no `flipped`
		// flag, and on a WebGL board no `flipped` class either) would mirror every square.
		// `getMyColor()` never consults `isFlipped()`, so there is no cycle. It returns null early
		// for analysis and spectated pages, which is why it is a fallback and not the answer.
		const shown = this.bottomColor();
		if (shown !== null) return shown === "b";
		const mine = this.getMyColor();
		return mine !== null && mine === "b";
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

	/** Discover a control without activating it, or revalidate the exact element under a point. */
	newGameTarget(
		mode: NewGameMode,
		expectedGameId?: string | null,
		targetId?: string,
		point?: Pt
	): NewGameTargetResult {
		const currentId = this.urlGameId() ?? this.readSnapshot()?.gameId;
		if (expectedGameId && currentId && currentId !== expectedGameId) return { status: "in-game" };
		const kind = pageKindFromPath(this.win.location.pathname);
		if (kind !== "live-game" && kind !== "live-lobby" && kind !== "vs-computer")
			return { status: "not-ready" };
		if (newGameSearchActive(this.doc, this.win)) return { status: "searching" };
		const running = [this.getClock("w"), this.getClock("b")].some(
			(clock) => clock?.running && clock.ms > 0
		);
		const playing = this.bridgeState?.mode === "playing" && this.bridgeState.gameOver === false;
		if (
			!this.isGameOver() &&
			this.getMyColor() !== null &&
			this.getFen() !== null &&
			(running || playing)
		)
			return { status: "in-game" };
		const control = newGameControl(
			this.doc,
			this.win,
			mode,
			kind === "vs-computer",
			kind === "live-lobby"
		);
		if (!control) return { status: "not-ready" };
		if (
			targetId !== undefined &&
			(this.restartControl !== control || targetId !== this.restartTargetId)
		)
			return { status: "not-ready" };
		if (point) {
			const hit = this.doc.elementFromPoint(point.x, point.y);
			if (!hit || (hit !== control && !control.contains(hit))) return { status: "not-ready" };
		}
		if (this.restartControl !== control) {
			this.restartControl = control;
			this.restartTargetId = this.win.crypto.randomUUID();
		}
		const rect = control.getBoundingClientRect();
		return {
			status: "ready",
			target: {
				targetId: this.restartTargetId,
				rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
				viewport: { width: this.win.innerWidth, height: this.win.innerHeight },
			},
		};
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
			this.observe(clock, {
				attributes: true,
				attributeFilter: ["class"],
				childList: true,
				subtree: true,
				characterData: true,
			});
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
		const sideToMove = this.reconciledTurn(info, this.sideToMoveFor(placement, list));
		const ply = plyOf(list);
		const replay = replayMoves(list.sans.slice(0, ply));
		const lastMove = replay?.lastMove ?? this.bridgeLastMove();
		const gameId = this.gameIdentity(ply);
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
			// actually starts, which is why `AdapterBase.apply` republishes an unmoved position when
			// it arrives and why the session re-profiles on it.
			...(timeControl ? { timeControl } : {}),
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

	/**
	 * The overlay branch of the bridge draws from screen coordinates, so it needs the board's
	 * orientation; native markings name squares and do not. Nothing sent it before, so an overlay
	 * mark was mirrored for the whole of every game played as black — harmless while the overlay
	 * was only the no-`game.markings` fallback, not harmless now that `forceOverlay` routes the
	 * mark of the move being played through it. `isFlipped()` already means "black at the bottom",
	 * which is what the overlay means by `black`.
	 */
	protected drawPayload(
		highlights: Array<{ square: Square; color: string }>,
		arrows: Array<{ from: Square; to: Square; color: string }>,
		options: DrawOptions
	): unknown {
		return {
			arrows,
			highlights,
			orientation: this.isFlipped() ? "black" : "white",
			...(options.forceOverlay === true ? { forceOverlay: true } : {}),
		};
	}

	/**
	 * Which markings to remove. The page side reads `(q && q.keys) || keys` — its own record of
	 * everything it drew — so an **empty** array is a truthy no-op that clears nothing. The key is
	 * therefore omitted unless we actually have keys to name, which makes a clear with no recorded
	 * keys mean "everything of ours" rather than "nothing".
	 */
	protected clearPayload(): unknown {
		return this.highlightKeys.length > 0 ? { keys: [...this.highlightKeys] } : {};
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

	/**
	 * One turn per snapshot: the side to move published beside a FEN is that FEN's own.
	 *
	 * `positionInfoFor` and `sideToMoveFor` are two different ladders over the same page (bridge →
	 * replay → DOM against bridge → active clock → move-list parity), so they can answer
	 * differently — a replay that is white to move while the clocks still mark black's, say. Every
	 * search, every recommendation and every plan downstream is for whoever the **FEN** says is to
	 * move, while `GameSession.myTurn` is `sideToMove === myColor`: publish the contradiction and the
	 * session recommends the *opponent's* move and calls it ours (owner's live game, 2026-09-10 —
	 * white's first move, shown to a black player).
	 *
	 * So the FEN wins whenever it carries a turn field. A DOM approximation is no exception and needs
	 * no special case: `approximateFen` is built *from* `observed`, so the two already agree there.
	 * A FEN with no readable turn field (the site answering a bare placement) is the only case left
	 * to the observed value — nothing else is known about it.
	 *
	 * The read is `turnFieldOf`, not `sideToMove`: whose move it is does not depend on chess.js
	 * accepting the rest of the position, and a strict parse would answer `null` for a FEN with one
	 * malformed field and quietly hand the turn back to the clocks — the very disagreement this
	 * exists to settle. `reconciledTurn` runs on every reading; `AdapterBase` holds the same line for
	 * every *published* snapshot, whatever the adapter.
	 */
	private reconciledTurn(info: PositionInfo, observed: Color | null): Color {
		const fromFen = turnFieldOf(info.fen);
		if (fromFen === null) return observed ?? "w";
		if (observed !== null && observed !== fromFen)
			log.debug("adapter.turnDisagreed", {
				site: SITE,
				source: info.source,
				fen: fromFen,
				observed,
			});
		return fromFen;
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
