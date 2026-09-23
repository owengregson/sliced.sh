// scripts/verify-dist/policy.ts — what a package may contain: budgets, bundle roles, host
// ownership and banned manifest keys. Data only; the checks that enforce it live beside it.

const KIB = 1024;

/** §11.2 bundle budgets, keyed by dist-relative posix path. */
export const BUNDLE_BUDGETS: Readonly<Record<string, number>> = {
	"js/panel.js": 400 * KIB,
	"js/content.js": 250 * KIB,
};

/** Bundle roles, as dist-relative paths (`HOST_OWNERS` keys off them). */
export const BUNDLES = {
	serviceWorker: "js/service-worker.js",
	panel: "js/panel.js",
	offscreen: "js/offscreen.js",
	content: "js/content.js",
} as const;

/** The one bundle allowed to carry the licence host: the licence client runs in the SW. */
export const LICENSE_BUNDLE = BUNDLES.serviceWorker;

const SW_AND_PANEL = [BUNDLES.serviceWorker, BUNDLES.panel] as const;

/**
 * Which bundles may carry each host found in `src/core/constants/**` (plus the build config's
 * licence endpoint). A derived host that is missing from this table fails the build: classifying
 * a new URL is the point of the rule, not a formality.
 *
 * The service worker owns every outbound request; the panel carries the whole registry because
 * `src/panel/actions.ts` imports `URLS` as an object to resolve `data-url="…"` links, and a
 * bundler inlines an object literal whole. Neither is reachable from a page — the panel and the
 * offscreen document are extension pages. What must stay empty is the page realm: `content.js`
 * runs in the ISOLATED world on the site's own origin, and `js/page/*.js` run in MAIN.
 */
export const HOST_OWNERS: Readonly<Record<string, readonly string[]>> = {
	// Licence vendor — the client runs only in the SW.
	"phantom.ac": [BUNDLES.serviceWorker],
	// Product site: the update poll (SW) and the panel's links.
	"sliced.sh": SW_AND_PANEL,
	// NNUE mirror and its redirect target — both fetched by the SW.
	"tests.stockfishchess.org": SW_AND_PANEL,
	"data.stockfishchess.org": SW_AND_PANEL,
	// The site, as a navigable link in the panel's Not-supported view.
	"www.chess.com": SW_AND_PANEL,
	// Upstream metadata for the vendored components (licence notices, not requests).
	"github.com": SW_AND_PANEL,
	"raw.githubusercontent.com": SW_AND_PANEL,
	"polyformproject.org": SW_AND_PANEL,
	"1e4.ai": SW_AND_PANEL,
	// Maia-3 provenance (`MAIA_UPSTREAM`): licence text, paper and model hub — notices, never fetched.
	"www.gnu.org": SW_AND_PANEL,
	"arxiv.org": SW_AND_PANEL,
	"huggingface.co": SW_AND_PANEL,
};

/** Registry sources scanned for hosts (repo-relative). */
export const REGISTRY_DIR = "src/core/constants";

/** Manifest keys that must never come back (§12.2 drops the self-hosted CRX update feed). */
export const FORBIDDEN_MANIFEST_KEYS = ["update_url"] as const;
