/**
 * What a tab's new URL means for the auto-queue: whether the tab stayed on a chess.com page a
 * queued game can land on (so a pending queue is kept across the navigation).
 */

import { pageKindFromPath } from "@content/adapters/page-kind";
import { URLS } from "@core/constants/urls";

/** Is `url` a chess.com page a queued game plays on (live game, live lobby, vs-computer)? */
export function isQueuePageUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const kind = pageKindFromPath(parsed.pathname);
		return (
			parsed.origin === new URL(URLS.chesscom).origin &&
			(kind === "live-game" || kind === "live-lobby" || kind === "vs-computer")
		);
	} catch {
		/* An invalid destination cancels pending input. */
		return false;
	}
}
