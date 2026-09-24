/**
 * Whether the game on the page is over, and how: the bridge's result, then the move list's
 * result row, then the game-over modal's header (which speaks from our side: "you won").
 */

import type { Color, GameResult, PageKind } from "@typedefs/game";
import type { BridgeState } from "../bridge-protocol";
import type { MoveList } from "../move-list";
import { queryFirst, querySafe } from "../query";
import { SELECTORS as S } from "../selectors";

function parseResult(text: string | null | undefined): GameResult | null {
	if (text === "1-0" || text === "0-1" || text === "1/2-1/2") return text;
	return null;
}

/** `null` while the game is on; `"*"` for an ended game whose result the page does not say. */
export function gameResultOf(
	doc: Document,
	state: BridgeState | null,
	list: MoveList,
	pageKind: () => PageKind,
	myColour: () => Color | null
): GameResult | null {
	const s = state;
	if (s?.result && s.result !== "*") return parseResult(s.result);
	if (s?.gameOver) return parseResult(s.result) ?? "*";
	if (list.result) return list.result;
	const over = queryFirst(S.gameOver, doc)?.element;
	if (!over) return pageKind() === "live-postgame" ? "*" : null;
	const header = querySafe(doc, S.gameOverHeader);
	const m = S.gameOverHeaderClassRe.exec(header?.getAttribute("class") ?? "");
	const me = myColour();
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
