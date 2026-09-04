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
	/** Smallnet weights bundled in `assets/engine/` (§6.1); `nn-<sha256[0:12]>.nnue`. */
	nnueSmallName: "nn-4ca89e4b3abf.nnue",
	/** Full-strength `sf_18` dual nets `[big, small]`, fetched on demand into OPFS (Task 12). */
	nnueBigNames: ["nn-c288c895ea92.nnue", "nn-37f18f62d772.nnue"],
} as const;

/**
 * §3.6: the license gate is force-valid unless `build.config.json`
 * `licenseEnforce` is true. The only runtime reference to the define.
 */
export const LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__;
