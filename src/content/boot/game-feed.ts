/**
 * The game feed: what the content script tells the service worker about the page and its game.
 *
 *   - `hello` (`site`, `pageKind`, `adapterVersion`, `lobby`) at boot and whenever the page kind
 *     or the lobby flag changes, followed by the `opponent`;
 *   - V2.1: every live game page starts a session as soon as the board is readable —
 *     `gameStarted` (once per game id) and the current `position`, with a readiness poll at
 *     `TIMINGS.contentReadyPollMs` until then — then every position change (with `capturedAt`)
 *     and the `moveObserved` it implies.
 */

import type { AdapterPositionSnapshot, SiteAdapter } from "@content/adapters/adapter";
import type { GamePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { PageKind, PositionSnapshot, Site } from "@typedefs/game";
import type { OpponentPoll } from "./opponent-poll";
import type { PageState } from "./page-state";

const LIVE_KINDS: ReadonlySet<PageKind> = new Set(["live-game", "vs-computer", "live-postgame"]);

export interface GameFeedDeps {
	site: Site;
	adapterVersion: string;
	adapter: SiteAdapter;
	page: PageState;
	opponent: OpponentPoll;
	post(msg: GamePortMessage): void;
	disposed(): boolean;
	/** A new game id is being followed. */
	onGame(gameId: string): void;
	/** The page kind or lobby flag changed (before `hello` is re-sent). */
	onPageChanged(): void;
}

export interface GameFeed {
	hello(): void;
	/** `gameStarted` (once per game id) then `position`. */
	publish(s: AdapterPositionSnapshot): void;
	startSessionIfLive(): void;
	/** Re-detect the page kind; re-announce the page when it changed. */
	redetect(): void;
	stopReadyPoll(): void;
}

export function createGameFeed(deps: GameFeedDeps): GameFeed {
	const { site, adapter, page, post } = deps;
	let sessionGameId: string | null = null;
	let readyTimer: ReturnType<typeof setInterval> | null = null;

	const hello = (): void =>
		post({
			kind: "hello",
			site,
			pageKind: page.kind,
			adapterVersion: deps.adapterVersion,
			...(page.lobby ? { lobby: true } : {}),
		});

	const publish = (s: AdapterPositionSnapshot): void => {
		// `approximate` travels with the snapshot: the service worker cannot otherwise tell a FEN the
		// page gave us from one the adapter reconstructed, and a reading derived from the move-list ply
		// is exactly what a first-move decision must not trust (§13.4, the 2026-09-10 ruling).
		const snapshot: PositionSnapshot = s;
		if (snapshot.gameId !== sessionGameId) {
			sessionGameId = snapshot.gameId;
			deps.onGame(snapshot.gameId);
			stopReadyPoll();
			post({
				kind: "gameStarted",
				game: {
					gameId: snapshot.gameId,
					site,
					pageKind: page.kind,
					myColor: snapshot.myColor,
					...(snapshot.timeControl ? { timeControl: snapshot.timeControl } : {}),
					startedAt: snapshot.capturedAt,
					...(page.lobby ? { lobby: true } : {}),
				},
			});
			deps.opponent.read();
		}
		post({ kind: "position", snapshot });
		if (snapshot.lastMove && snapshot.lastMove.san !== "") {
			post({
				kind: "moveObserved",
				san: snapshot.lastMove.san,
				ply: snapshot.ply,
				byMe: snapshot.myColor !== null && snapshot.sideToMove !== snapshot.myColor,
				atMs: snapshot.capturedAt,
			});
		}
	};

	const startSessionIfLive = (): void => {
		if (sessionGameId !== null || !LIVE_KINDS.has(page.kind)) return;
		const s = adapter.readSnapshot();
		if (s) {
			publish(s);
			if (page.kind === "live-postgame") post({ kind: "gameEnded", result: "*" });
		} else startReadyPoll();
	};

	function startReadyPoll(): void {
		if (readyTimer !== null || deps.disposed()) return;
		readyTimer = setInterval(() => startSessionIfLive(), TIMINGS.contentReadyPollMs);
	}
	function stopReadyPoll(): void {
		if (readyTimer === null) return;
		clearInterval(readyTimer);
		readyTimer = null;
	}

	const redetect = (): void => {
		if (deps.disposed()) return;
		if (page.refresh()) {
			// SPA navigation off a game page (the route changes between games, and to the
			// analysis board after one): the page gets its mouse back, smoothly.
			deps.onPageChanged();
			hello();
			deps.opponent.read();
		}
		if (!LIVE_KINDS.has(page.kind)) stopReadyPoll();
		startSessionIfLive();
	};

	return { hello, publish, startSessionIfLive, redetect, stopReadyPoll };
}
