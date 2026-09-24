/**
 * The chess.com board's own elements: the board, its move list and clocks, which renderer draws
 * it, and the squares its last-move marks name.
 */

import { squareOf } from "@core/chess/squares";
import type { Square } from "@typedefs/game";
import { placementFromDom } from "../dom-fen";
import { queryAllSafe, queryFirstElement, querySafe } from "../query";
import { SELECTORS as S } from "../selectors";

/**
 * How this board renders its pieces. chess.com ships two renderers: `/play/computer` still lays
 * out `.piece` divs (`"pieces"`), while the live board draws into a `<canvas>` (WebGL) and has
 * none (`"canvas"`). Behavioural, not class-based: `board-webgl-2d` is a name chess.com may
 * change, "no piece element" is not.
 */
export type BoardRenderer = "pieces" | "canvas";

export function rendererOf(board: Element): BoardRenderer {
	return querySafe(board, S.piece) !== null ? "pieces" : "canvas";
}

/** The 8×8 board element (`wc-chess-board`). */
export function boardOf(doc: Document): Element | null {
	return queryFirstElement(S.board, doc);
}

/** The move list (absent on the live page until the first move is played). */
export function moveListOf(doc: Document): Element | null {
	return queryFirstElement(S.moveList, doc);
}

/** The clock elements; the computer page's elapsed-move counters count as clocks there. */
export function clockElementsOf(doc: Document, computer: boolean): Element[] {
	return queryAllSafe(doc, computer ? `${S.clock},${S.computerClock}` : S.clock);
}

/** DOM-only placement; `null` for a canvas board, or a pieces board mid-animation. */
export function domPlacementOf(board: Element | null): string | null {
	return board ? placementFromDom(board) : null;
}

/** DOM renderer only: a `.piece.dragging` means the markup is mid-gesture. */
export function midGesture(board: Element): boolean {
	return querySafe(board, S.dragging) !== null;
}

function squareFromClass(el: Element): Square | null {
	const m = S.squareRe.exec(el.getAttribute("class") ?? "");
	if (!m) return null;
	return squareOf(Number(m[1]) - 1, Number(m[2]) - 1);
}

/**
 * Squares of the `.highlight` elements (last move, unless a selection/premove is pending). Empty
 * on a canvas board.
 */
export function highlightSquaresOf(board: Element | null): Square[] {
	if (!board) return [];
	return queryAllSafe(board, S.highlight)
		.map(squareFromClass)
		.filter((s): s is Square => s !== null);
}
