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
const CHESSCOM_COMPUTER = /^\/play\/(computer|bots)(?:[/?#]|$)/;
const CHESSCOM_DAILY = /^\/(game\/daily|daily)(?:[/?#]|$)/;
const CHESSCOM_ANALYSIS = /^\/analysis(?:[/?#]|$)/;
const CHESSCOM_PUZZLES = /^\/puzzles(?:[/?#]|$)/;

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
