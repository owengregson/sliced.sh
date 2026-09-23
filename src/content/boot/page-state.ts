import type { SiteAdapter } from "@content/adapters/adapter";
import { isLobbyPath } from "@content/adapters/page-kind";
import type { PageKind } from "@typedefs/game";

/** What `hello` states about the page: its kind, and whether it is the queue screen. */
export interface PageState {
	readonly kind: PageKind;
	/**
	 * The exact `/play/online` queue screen (2026-09-13). Its board reports itself as a live game,
	 * so the page kind cannot say "no game has been queued yet"; the URL can, and it travels with
	 * `hello` and `gameStarted` for the service worker's lobby hold. Re-sent when it changes.
	 */
	readonly lobby: boolean;
	/** Re-read both; whether either changed. */
	refresh(): boolean;
}

export function createPageState(adapter: SiteAdapter, win: Window): PageState {
	const lobbyPath = (): boolean => isLobbyPath(win.location.pathname);
	let kind = adapter.detectPageKind();
	let lobby = lobbyPath();
	return {
		get kind() {
			return kind;
		},
		get lobby() {
			return lobby;
		},
		refresh() {
			const nextKind = adapter.detectPageKind();
			// The lobby flag is part of what `hello` states: `/play/online` → `/game/<id>` keeps the
			// refined kind (`live-game` both sides) and must still be announced.
			const onLobby = lobbyPath();
			if (nextKind === kind && onLobby === lobby) return false;
			kind = nextKind;
			lobby = onLobby;
			return true;
		},
	};
}
