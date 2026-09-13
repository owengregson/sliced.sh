/**
 * Rematching titled players (owner's brief, 2026-09-13): after a game against a titled opponent
 * the auto-queue offers one rematch — or accepts theirs — before it queues a regular game; an
 * offer nobody takes within `acceptTimeoutMs` is dismissed and the ordinary queue click follows.
 * C1 registry: every knob of that rule lives here, once.
 *
 * The decision and the wait live in `src/service/rematch.ts`, the clicks go through the same
 * hand-driven path the queue's "new game" click uses (`NewGameInput`), and the control discovery
 * is the content adapter's (`SiteAdapter.rematchTarget`, selectors in
 * `src/content/adapters/selectors.ts`).
 */

export const REMATCH = {
	/** How long an offer (ours or theirs, once accepted) may take to start the next game (ms). */
	acceptTimeoutMs: 15_000,
	/** Rematches per opponent per playing session — "we only rematch them one time". */
	offersPerOpponent: 1,
	/** Cadence of the passive "is an incoming offer showing" read while waiting (ms). */
	incomingPollMs: 1_000,
	/** Port request budget for one `rematch` target read / revalidation (ms). */
	targetTimeoutMs: 2_000,
} as const;

/**
 * The titles chess.com renders in the player card's `cc-user-title-component`. Any non-empty
 * title text of that shape counts as titled (`TITLE_RE`); this list documents the known ones and
 * backs the sanity check in `normaliseTitle`, it is not a hard filter — a title chess.com adds
 * later must still count.
 */
export const TITLES = ["GM", "IM", "FM", "CM", "NM", "WGM", "WIM", "WFM", "WCM"] as const;

/** What a title reads like once trimmed and upper-cased: two to four letters, nothing else. */
export const TITLE_RE = /^[A-Z]{2,4}$/;

/**
 * The upper-cased, trimmed title text, or `undefined` when the text is not a title at all (an
 * empty element, a sentence, a number). Shared by the adapter that reads the card and the
 * service that decides on it, so both agree on what "titled" means.
 */
export function normaliseTitle(text: string | null | undefined): string | undefined {
	const title = (text ?? "").replace(/\s+/g, "").toUpperCase();
	return TITLE_RE.test(title) ? title : undefined;
}
