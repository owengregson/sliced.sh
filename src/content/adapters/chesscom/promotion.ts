import type { Color, PromoPiece, Square } from "@typedefs/game";
import type { Rect } from "../contract";
import { toRect } from "../geometry";
import { queryAllSafe, queryFirstElement, querySafe } from "../query";
import { PROMOTION_ORDER, SELECTORS as S } from "../selectors";

/**
 * Where to click for `piece` once the promotion picker is open; `null` while it is closed. The
 * picker's colour is ours, else the colour promoting on `dest`'s rank.
 */
export function promotionTargetRectOf(
	doc: Document,
	myColour: () => Color | null,
	dest: Square,
	piece: PromoPiece
): Rect | null {
	const win = queryFirstElement(S.promotionWindow, doc);
	if (!win) return null;
	const color: Color = myColour() ?? (dest.charAt(1) === "8" ? "w" : "b");
	const el =
		querySafe(win, S.promotionPiece(color, piece)) ??
		queryAllSafe(win, S.promotionPieceAny)[PROMOTION_ORDER.indexOf(piece)] ??
		null;
	if (!el) return null;
	const r = toRect(el.getBoundingClientRect());
	return r.width > 0 ? r : null;
}
