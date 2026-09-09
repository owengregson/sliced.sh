/**
 * The pointer's real position, asked of the content script (§5.5
 * `cursor-probe`). `HandOwnership` already counts and remembers the `cursor`
 * samples that arrive on the game port; this is the *pull* side, used at arm
 * time so the virtual hand starts where the user's mouse actually is rather
 * than at a synthetic rest point (§13.5 "the hand starts each game from a
 * plausible rest point").
 *
 * Read-only: the reply is the page's own last trusted pointer position; nothing
 * is dispatched and nothing is stored in the page.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import type { Pt } from "@core/motor/types";
import { errorMessage } from "@core/util/errors";
import type { ContentLink } from "@service/content-link";

export type CursorLink = Pick<ContentLink, "request">;

/**
 * The last trusted pointer position on `tabId`, or `null` when the page has
 * none / did not answer in time or the sample is older than
 * `EXECUTOR.realCursorMaxAgeMs`.
 */
export async function probeRealCursor(
	link: CursorLink,
	tabId: number,
	now: () => number,
	timeoutMs = EXECUTOR.geometryTimeoutMs
): Promise<Pt | null> {
	try {
		const reply = await link.request(tabId, { kind: "cursorProbe" }, timeoutMs);
		const p = reply.position;
		if (!p) return null;
		if (now() - p.t > EXECUTOR.realCursorMaxAgeMs) return null;
		return { x: p.x, y: p.y };
	} catch (error) {
		log.debug("content: cursor probe unavailable", { tabId, error: errorMessage(error) });
		return null;
	}
}
