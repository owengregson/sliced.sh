export const LIMITS = {
	eloMin: 400,
	eloMax: 3200,
	engineEloMin: 1320,
	engineEloMax: 3190,
	multiPvMin: 1,
	multiPvMax: 8,
	depthMin: 6,
	depthMax: 30,
	threadsMax: 8,
	hashMbMin: 16,
	hashMbMax: 128,
	blunderScaleMin: 0,
	blunderScaleMax: 2,
	previewSelectScaleMin: 0.5,
	previewSelectScaleMax: 2,
	timingLogMax: 200,
	analysisCacheEntries: 256,
	cpClamp: 1000,
	/** Lichess win-probability logistic `win(cp) = 1/(1+e^(−k·cp))` (§7.2, Appendix E §7.2). */
	winProbK: 0.00368208,
	/** Smallnet weights bundled in `assets/engine/` (§6.1); `nn-<sha256[0:12]>.nnue`. */
	nnueSmallName: "nn-4ca89e4b3abf.nnue",
	/** Full-strength `sf_18` dual nets `[big, small]`, fetched on demand into OPFS (Task 12). */
	nnueBigNames: ["nn-c288c895ea92.nnue", "nn-37f18f62d772.nnue"],
	/** Raw bytes per `nnue-chunk` relayed SW → offscreen (before base64) (Task 12). */
	nnueChunkBytes: 4_194_304,
	/** Shared `WebAssembly.Memory` initial pages (64 KiB each) tried in order (§6.3). */
	engineMemoryInitialPages: [2560, 1536, 1024],
	/** Shared `WebAssembly.Memory` maximum pages (512 MiB). */
	engineMemoryMaxPages: 8192,
} as const;

/**
 * §3.6: the license gate is force-valid unless `build.config.json`
 * `licenseEnforce` is true. The only runtime reference to the define.
 */
export const LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__;
