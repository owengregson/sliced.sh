export const URLS = {
	website: "https://sliced.sh",
	licenseEndpoint: __SL_LICENSE_URL__, // build-time; default https://phantom.ac/slicedgg/index.php
	lichessExplorer: "https://explorer.lichess.ovh/lichess",
	nnueMirror: "https://tests.stockfishchess.org/api/nn/",
	/**
	 * Match patterns the manifest's `host_permissions` must contain for the SW's net
	 * download (Task 12): the mirror answers `302 → data.stockfishchess.org` without
	 * `Access-Control-Allow-Origin`, and extension fetches to hosts covered by a host
	 * permission bypass CORS. `test/scripts/manifest-hosts.test.ts` keeps them in sync.
	 */
	nnueMirrorHosts: ["https://tests.stockfishchess.org/*", "https://data.stockfishchess.org/*"],
	chesscomMatch: "*://*.chess.com/*",
	lichessMatch: "*://*.lichess.org/*",
} as const;
