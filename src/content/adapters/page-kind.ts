/**
 * URL page-kind detection (Appendix C §1.1). The adapter refines the result
 * with the bridge's reported mode.
 */

import type { PageKind } from "@typedefs/game";

/**
 * Live game URL. chess.com serves live games at `/game/<digits>` (owner's
 * capture, 2026-09-09); `/game/live/<digits>` is the older form. `/game/daily/…`
 * falls through to the daily pattern and the archive's `/games/view/<id>` never
 * matches (`/games/` ≠ `/game/`).
 */
const CHESSCOM_LIVE_GAME = /^\/game\/(?:live\/)?\d+/;
const CHESSCOM_LOBBY = /^\/play\/online|^\/live(?:[/#?]|$)/;
/**
 * The queue screen *before* a game has been queued: exactly `/play/online` (a trailing slash
 * allowed), nothing after it. `/play/online/new`, `/live` and `/game/<id>` are not it (owner,
 * 2026-09-13: "…/play/online/ (no other url)"). The page's own game object reports this board as
 * `playing`, so the page kind alone cannot tell it from a live game; the flag travels with `hello`
 * and `gameStarted` and the service worker's lobby hold reads it with the clocks.
 */
const CHESSCOM_LOBBY_EXACT = /^\/play\/online\/?$/;
const CHESSCOM_COMPUTER = /^\/play\/(computer|bots)(?:[/?#]|$)/;
const CHESSCOM_DAILY = /^\/(game\/daily|daily)(?:[/?#]|$)/;
const CHESSCOM_ANALYSIS = /^\/analysis(?:[/?#]|$)/;
const CHESSCOM_PUZZLES = /^\/puzzles(?:[/?#]|$)/;

/**
 * The page kinds a game can be played on (`/play/online`, `/play/computer`, `/game/<digits>`,
 * `/game/live/<digits>`), and therefore the only ones on which the hand may own the pointer: the
 * input shield, keyboard exclusivity and the mirror are gated on these (owner, 2026-09-13: "when on
 * a page that isnt a game page … we shouldnt lock cursor/disable input on the page"). Spectating,
 * daily, analysis, puzzles and everything else keep the real mouse.
 */
export const GAME_PAGE_KINDS: ReadonlySet<PageKind> = new Set<PageKind>([
	"live-game",
	"live-lobby",
	"vs-computer",
]);

export function isGamePage(kind: PageKind): boolean {
	return GAME_PAGE_KINDS.has(kind);
}

/** Is `pathname` the exact `/play/online` queue screen? Query and hash are ignored. */
export function isLobbyPath(pathname: string): boolean {
	const p = pathname.split(/[?#]/)[0] ?? pathname;
	return CHESSCOM_LOBBY_EXACT.test(p);
}

export function pageKindFromPath(pathname: string): PageKind {
	const p = pathname.split(/[?#]/)[0] ?? pathname;
	if (CHESSCOM_LIVE_GAME.test(p)) return "live-game";
	// becomes live-game when the bridge reports mode "playing" (adapter refinement)
	if (CHESSCOM_LOBBY.test(p)) return "live-lobby";
	if (CHESSCOM_COMPUTER.test(p)) return "vs-computer";
	if (CHESSCOM_DAILY.test(p)) return "daily";
	if (CHESSCOM_ANALYSIS.test(p)) return "analysis";
	if (CHESSCOM_PUZZLES.test(p)) return "puzzles";
	return "other";
}
