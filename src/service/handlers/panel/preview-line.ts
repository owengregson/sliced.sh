/**
 * `PANEL_PREVIEW_LINE { tabId, multipv | null }` → highlight the hovered line's first move on
 * the board through the game port (`multipv: null` restores the chosen move); an unknown line
 * clears rather than guesses. The content script only draws while
 * `Settings.automation.highlightMoves` is on (§13.3 rule 4), so this posts unconditionally.
 */

import { isSquare } from "@core/chess/squares";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import { getSettings } from "@core/storage/settings-storage";
import type { PanelHandlerDeps } from "@service/handlers/panel";
import type { Recommendation, Square } from "@typedefs/game";

/** The move a preview of `multipv` shows: the chosen move for `null`, else the line's first move. */
export function previewMove(
	rec: Recommendation,
	multipv: number | null
): { from: Square; to: Square } | null {
	if (multipv === null) return { from: rec.chosen.from, to: rec.chosen.to };
	const uci = rec.lines.find((line) => line.multipv === multipv)?.pvUci[0];
	if (!uci || uci.length < 4) return null;
	const from = uci.slice(0, 2);
	const to = uci.slice(2, 4);
	return isSquare(from) && isSquare(to) ? { from, to } : null;
}

export function registerPreviewLineHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "sources" | "link">
): void {
	router.on(MSG.PANEL_PREVIEW_LINE, async (msg) => {
		const link = deps.link;
		if (!link) {
			log.debug("panel: preview ignored (no content link yet)", { tabId: msg.tabId });
			return;
		}
		const rec = deps.sources.session(msg.tabId)?.recommendation() ?? null;
		const move = rec ? previewMove(rec, msg.multipv) : null;
		if (!move) {
			link.post(msg.tabId, { kind: "clearHighlight" });
			return;
		}
		// A storage read per hover; Task 30's session keeps the current settings and replaces this.
		const settings = await getSettings();
		link.post(msg.tabId, {
			kind: "highlight",
			from: move.from,
			to: move.to,
			style: settings.automation.highlightStyle,
		});
	});
}
