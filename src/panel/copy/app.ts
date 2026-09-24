/** Shell-wide strings: brand, navigation, the workspace headings, footer and accessibility words. */

import { PLAY_NOW, SITE } from "./site";

export const BRAND_COPY = {
	name: "sliced",
	product: "sliced.sh",
	tagline: `Chess assistant for ${SITE}`,
} as const;

export const NAV_COPY = {
	game: "Game",
	settings: "Settings",
	engine: "Engine",
	viewSwitch: "Panel navigation",
} as const;

export const WORKSPACE_COPY = {
	connecting: "Connecting…",
	connectingBody: "Loading session and settings.",
	live: "Live",
	/** The Live view's eyebrow while the lobby hold is on: a board, but no game queued yet. */
	lobby: "Lobby · no game queued",
	yourTurn: "Your move",
	theirTurn: "Waiting…",
	setup: "Session setup",
	settingsTitle: "Settings",
	settingsBody: "Choose how sliced plays, moves and gives feedback. Changes save automatically.",
	engineTitle: "Engine diagnostics",
	engineBody: "Engine, input and timing status.",
	shortcuts: "Page shortcuts",
	playNow: PLAY_NOW,
	autoPlay: "Auto-play",
	stop: "Stop",
	searchSettings: "Search settings",
	searchPlaceholder: "Search settings…",
	noSettings: "No matching settings.",
	saving: "Saving…",
	saved: "Saved",
	saveFailed: "Save failed. Previous values restored.",
} as const;

export const COMMON_COPY = {
	close: "Close",
	back: "Back",
	loading: "Loading…",
	on: "On",
	off: "Off",
	popoverClose: "Close",
} as const;

export const FOOTER_COPY = (version: string, build: string): string =>
	`sliced v${version} · build ${build}`;

/** Third-party notices under the footer (Task 34; the full texts are in docs/third-party.md). */
export const NOTICES_COPY = {
	engine: "Stockfish 19 · GPL-3.0 / AGPL-3.0 · lichess-org/stockfish-web",
	timing: "ChessMimic timing model © 2026 Thomas Johnson · PolyForm Noncommercial 1.0.0",
} as const;

export const A11Y_COPY = {
	pieces: { N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" },
	takes: "takes",
	check: "check",
	checkmate: "checkmate",
	castleKing: "castles kingside",
	castleQueen: "castles queenside",
	promotes: "promotes to",
	toggleHoldHint: "Hold to arm auto-play",
} as const;
