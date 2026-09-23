/**
 * What kind of chess.com page this is, which game it names, and who the opponent is.
 */

import { normaliseTitle } from "@core/constants/rematch";
import type { PageKind } from "@typedefs/game";
import { type BridgeState, bridgeColor } from "../bridge-protocol";
import type { Opponent } from "../contract";
import { newGameControl, newGameSearchActive, rendered } from "../new-game";
import { pageKindFromPath } from "../page-kind";
import { queryAllSafe, queryFirstElement, querySafe } from "../query";
import { SELECTORS as S } from "../selectors";

/**
 * Game id in a live game URL. chess.com serves live games at `/game/<digits>`
 * (owner's capture, 2026-09-09); `/game/live/<digits>` is the older form and
 * still appears in links. `/game/daily/<id>` and the archive's
 * `/games/view/<id>` deliberately do not match.
 */
const LIVE_ID_RE = /^\/game\/(?:live\/)?(\d+)/;
const RATING_RE = /(\d{3,4})/;

function ratingFrom(text: string | null | undefined): number | null {
	const m = RATING_RE.exec(text ?? "");
	return m ? Number(m[1]) : null;
}

/** Game id from the URL, or `null` when the page has none (`/play/computer`). */
export function urlGameIdOf(win: Window): string | null {
	return LIVE_ID_RE.exec(win.location.pathname)?.[1] ?? null;
}

/** The URL's page kind, refined by the post-game toolbar and the bridge's mode. */
export function pageKindOf(doc: Document, win: Window, state: BridgeState | null): PageKind {
	const kind = pageKindFromPath(win.location.pathname);
	// This explicit read-only toolbar outranks a stale `playing` bridge state or live URL.
	if (
		(kind === "live-game" || kind === "live-lobby") &&
		queryAllSafe(doc, S.postGameToolbar).some((toolbar) =>
			S.postGameActions.every((selector) =>
				queryAllSafe(toolbar, selector).some((action) => rendered(action, win))
			)
		)
	)
		return newGameControl(doc, win, "new", false) || newGameSearchActive(doc, win)
			? "live-postgame"
			: "live-spectate";
	const mode = state?.mode;
	// The bridge mode only refines the live pages; puzzles/analysis/daily keep their URL kind.
	if (!mode || (kind !== "live-lobby" && kind !== "live-game")) return kind;
	if (mode === "playing" && bridgeColor(state?.playingAs) !== null) return "live-game";
	if (kind === "live-game" && (mode === "observing" || mode === "passive-observing"))
		return "live-spectate";
	if (mode === "analysis") return "analysis";
	return kind;
}

/** The opponent's card (the top player block, else the bot card); `null` when nothing is shown. */
export function opponentOf(doc: Document, kind: PageKind): Opponent | null {
	const top = queryFirstElement(S.playerTop, doc);
	const topName = top ? queryFirstElement(S.username, top)?.textContent?.trim() : undefined;
	const topRating = top ? ratingFrom(queryFirstElement(S.rating, top)?.textContent) : null;
	// The title chip lives in the same card as the rating; read inside the *opponent's* card only
	// (2026-09-13) — our own card carries one too when the owner is titled.
	const title = top ? normaliseTitle(querySafe(top, S.playerTitle)?.textContent) : undefined;
	const card = queryFirstElement(S.botCard, doc);
	const isBot = kind === "vs-computer" || card !== null;
	const name =
		topName || (card ? queryFirstElement(S.botName, card)?.textContent?.trim() : undefined) || "";
	const rating =
		topRating ?? (card ? ratingFrom(queryFirstElement(S.botRating, card)?.textContent) : null);
	if (!name && rating === null) return null;
	return { isBot, name, ratingEstimate: rating, ...(title !== undefined ? { title } : {}) };
}
