/**
 * The chess.com position ladders (Appendix C §3): where the FEN comes from, whose turn it is, and
 * how far the game has gone — each a function of the page's DOM, its move list and the bridge's
 * cached FEN. A canvas board has no DOM placement at all, which is what the bridge and the
 * move-list replay are for.
 */

import { turnFieldOf } from "@core/chess/fen";
import { log } from "@core/logger";
import type { Color, Site, Square } from "@typedefs/game";
import { type BridgeState, bridgeColor } from "../bridge-protocol";
import { activeClockColor } from "../clocks";
import type { MoveWatch, PositionInfo } from "../contract";
import { approximateFen, lastMoveBetween, placementOf, replayMoves } from "../dom-fen";
import type { MoveList } from "../move-list";
import { boardOf, highlightSquaresOf, moveListOf } from "./board";

const SITE: Site = "chesscom";

/** Plies up to the displayed position (the selected move, else the whole list). */
export function plyOf(list: MoveList): number {
	return list.selectedIndex >= 0 ? list.selectedIndex + 1 : list.sans.length;
}

/** The page's position sources for one reading. */
export interface PositionSources {
	readonly doc: Document;
	/** The bridge's cached FEN (`null` until it has answered one). */
	readonly bridgeFen: string | null;
	/** DOM placement (`null` on a canvas board). */
	readonly placement: string | null;
	readonly list: MoveList;
}

/**
 * Hybrid FEN (Appendix C §3): bridge → SAN replay → DOM placement with
 * `approximate`. A WebGL board has no DOM placement at all, which is exactly
 * what the first two sources are for.
 */
export function positionInfoFor(src: PositionSources): PositionInfo | null {
	const { placement, list } = src;
	const fromBridge = src.bridgeFen;
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
	const turn = sideToMoveFor(src) ?? "w";
	const fen = approximateFen(placement, turn, {
		fullmove: Math.floor(ply / 2) + 1,
		...(lastMoveBetween(placement, highlightSquaresOf(boardOf(src.doc))) ?? {}),
	});
	return { fen, approximate: true, source: "dom" };
}

/** Bridge FEN (when consistent with the DOM) → active clock → move-list parity. */
export function sideToMoveFor(src: PositionSources): Color | null {
	const { placement, list } = src;
	const fromBridge = src.bridgeFen;
	if (fromBridge && (placement === null || placementOf(fromBridge) === placement)) {
		const turn = fromBridge.split(" ")[1];
		if (turn === "w" || turn === "b") return turn;
	}
	const clock = activeClockColor(src.doc);
	if (clock) return clock;
	if (moveListOf(src.doc) === null) return null;
	return plyOf(list) % 2 === 0 ? "w" : "b";
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
 * exists to settle. It runs on every reading; `AdapterBase` holds the same line for
 * every *published* snapshot, whatever the adapter.
 */
export function reconciledTurn(info: PositionInfo, observed: Color | null): Color {
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

/** Placement of a board that renders no pieces: the move list's replay, else the bridge FEN. */
export function placementWithoutPieces(src: PositionSources): string | null {
	const sans = src.list.sans.slice(0, plyOf(src.list));
	const replay = moveListOf(src.doc) !== null && sans.length > 0 ? replayMoves(sans) : null;
	if (replay) return placementOf(replay.fen);
	const fen = src.bridgeFen;
	return fen === null ? null : placementOf(fen);
}

/**
 * What `observeMove` compares. With no `.piece` elements the move list is the
 * DOM evidence that a move landed, and its replay is the placement to check;
 * the bridge cache is the last resort because an unsolicited page event can
 * leave it one `getState` behind. `highlightSquares()` is empty on a WebGL
 * board, so confirmation there rests on the move count.
 */
export function moveWatchOf(src: PositionSources): MoveWatch {
	const { list, placement: dom } = src;
	const info = positionInfoFor(src);
	return {
		placement: dom ?? placementWithoutPieces(src),
		independentPlacement: dom !== null,
		moveCount: list.sans.length,
		lastMoveSquares: highlightSquaresOf(boardOf(src.doc)),
		...(info && !info.approximate ? { fen: info.fen } : {}),
		...(moveListOf(src.doc) !== null ? { history: list.sans.slice(0, plyOf(list)) } : {}),
	};
}

/** The turn the bridge states: its FEN's turn field, else its own `turn`. */
export function bridgeTurnOf(state: BridgeState | null): Color | null {
	const fen = state?.fen ?? null;
	const turn = fen?.split(" ")[1];
	if (turn === "w" || turn === "b") return turn;
	return bridgeColor(state?.turn);
}

export function bridgeLastMoveOf(
	state: BridgeState | null
): { from: Square; to: Square; san: string } | null {
	const lm = state?.lastMove;
	return lm ? { from: lm.from, to: lm.to, san: lm.san ?? "" } : null;
}
