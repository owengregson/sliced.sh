/**
 * The licence endpoint (build-time `__SL_LICENSE_URL__`; default
 * `https://phantom.ac/slicedgg/index.php`) is a **separate top-level binding, not a `URLS`
 * member**. A bundler inlines an object literal whole, so while it lived inside `URLS` the
 * vendor's hostname shipped in `panel.js` *and* `content.js` — and `content.js` runs on the
 * origin of the site we are trying not to be recognised on (§13.3). As its own export it is
 * tree-shaken out of every bundle that does not import the licence client, which only the
 * service worker does. `scripts/verify-dist.ts` fails the build if the host reappears
 * anywhere but `js/service-worker.js`.
 */
export const LICENSE_ENDPOINT: string = __SL_LICENSE_URL__;

export const URLS = {
	website: "https://sliced.sh",
	lichessExplorer: "https://explorer.lichess.ovh/lichess",
	nnueMirror: "https://tests.stockfishchess.org/api/nn/",
	/**
	 * Match patterns the manifest's `host_permissions` must contain for the SW's net
	 * download (Task 12): the mirror answers `302 → data.stockfishchess.org` without
	 * `Access-Control-Allow-Origin`, and extension fetches to hosts covered by a host
	 * permission bypass CORS. `test/scripts/manifest-hosts.test.ts` keeps them in sync.
	 */
	nnueMirrorHosts: ["https://tests.stockfishchess.org/*", "https://data.stockfishchess.org/*"],
	/**
	 * Task 34: ChessMimic bands that are registered but not bundled download from here
	 * (`<band>.onnx`, verified against `CHESSMIMIC_BAND_FILES`); the three shipped bands never do.
	 */
	chessmimicBandBase: "https://sliced.sh/models/chessmimic/",
	/** Task 34: onnxruntime sources; the MIT text is vendored from `<raw>/v<version>/LICENSE`. */
	onnxruntimeRepo: "https://github.com/microsoft/onnxruntime",
	onnxruntimeRaw: "https://raw.githubusercontent.com/microsoft/onnxruntime/",
	chesscomMatch: "*://*.chess.com/*",
	lichessMatch: "*://*.lichess.org/*",
	// Task 23: panel links (Appendix F §4.1 / §4.2 / §4.3)
	chesscom: "https://www.chess.com/",
	chesscomPlay: "https://www.chess.com/play/online",
	lichess: "https://lichess.org/",
	/** The lichess lobby is the site root (the plan's `/lobby` path has no such page). */
	lichessLobby: "https://lichess.org/",
} as const;
