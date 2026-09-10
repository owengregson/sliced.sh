/**
 * URL / DOM page-kind detection (Appendix C §1.1, §2.1). The adapters refine
 * these with the bridge mode (chess.com) and the AI opponent row (lichess).
 */

import type { PageKind } from "@typedefs/game";
import { SELECTORS } from "./selectors";

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

export function detectChesscomPageKind(pathname: string): PageKind {
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

const LICHESS_ANALYSIS = /^\/(analysis|study)(?:[/?#]|$)|\/analysis(?:[/?#]|$)/;
const LICHESS_PUZZLES = /^\/(training|storm|racer|streak)(?:[/?#]|$)/;
const LICHESS_GAME_URL = /^\/[a-zA-Z0-9]{8}([a-zA-Z0-9]{4})?(\/(white|black))?\/?$/;

/**
 * `doc` may be `null` before the page has booted (URL-only classification).
 * `main.round` + `body.playing` ⇒ player; `main.round` alone ⇒ spectator.
 */
export function detectLichessPageKind(pathname: string, doc: Document | null): PageKind {
	const p = pathname.split(/[?#]/)[0] ?? pathname;
	const L = SELECTORS.lichess;
	const main = doc?.querySelector(L.main) ?? null;
	if (main?.classList.contains(L.mainRoundClass)) {
		return doc?.body?.classList.contains(L.bodyPlayingClass) ? "live-game" : "live-spectate";
	}
	if (main?.classList.contains(L.mainAnalyseClass) || LICHESS_ANALYSIS.test(p)) return "analysis";
	if (LICHESS_PUZZLES.test(p)) return "puzzles";
	if (LICHESS_GAME_URL.test(p)) return "live-game"; // before the round app has booted
	return "other";
}
