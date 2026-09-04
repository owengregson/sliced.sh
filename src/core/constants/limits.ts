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
	timingLogMax: 200,
	analysisCacheEntries: 256,
	cpClamp: 1000,
} as const;

/**
 * §3.6: the license gate is force-valid unless `build.config.json`
 * `licenseEnforce` is true. The only runtime reference to the define.
 */
export const LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__;
