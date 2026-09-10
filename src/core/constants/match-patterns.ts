/**
 * The two site match patterns, as a **separate registry module rather than members of `URLS`**.
 *
 * Same bundling reason as `LICENSE_ENDPOINT`: a bundler inlines an object literal whole, so one
 * `URLS.chesscomMatch` in `src/content/site-detect.ts` was enough to ship every product and
 * vendor URL in the registry — `sliced.sh`, `sliced.sh/manifest.json`,
 * `sliced.sh/models/chessmimic/`, both Stockfish mirror hosts — inside

 * `content.js`, which runs on chess.com's and lichess's own origin. `sliced.sh` *names this
 * product*, so it is a stronger identifier than the licence host ever was (§13.3 rule 2).
 *
 * Content and the MAIN-world programs need these two strings and nothing else. `scripts/
 * verify-dist.ts` fails the build if any registry host reappears in a page-realm bundle.
 *
 * These must stay in step with `manifest.json`'s `content_scripts[].matches`
 * (`test/scripts/manifest-hosts.test.ts`).
 */
export const SITE_MATCHES = {
	chesscom: "*://*.chess.com/*",
	lichess: "*://*.lichess.org/*",
} as const;

export type SiteMatchPattern = (typeof SITE_MATCHES)[keyof typeof SITE_MATCHES];
