// src/pagescript/spoof.ts
/**
 * Spoofing for the emitter (§5.4). `deriveToken` itself lives in the
 * runtime-safe `@core/spoof` (shared with the ISOLATED-world content script);
 * this module re-exports it and adds the build/test-time seed resolution.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4) — only `src/core/spoof.ts` and the
 * `SPOOF_PURPOSES` registry are runtime-safe.
 */

export { deriveToken } from "@core/spoof";

/** Fixed seed used when no build seed is supplied (dev / standalone runs). */
export const DEV_SPOOF_SEED = "dev-seed-0000000000000000000000";

/**
 * The seed to spoof with: an explicit one, else the build define
 * `__SL_SPOOF_SEED__` (present in bundles and in `test/setup.ts`), else the
 * fixed dev seed.
 */
export function resolveSpoofSeed(explicit?: string): string {
	if (explicit !== undefined) return explicit;
	const defined = (globalThis as { __SL_SPOOF_SEED__?: unknown }).__SL_SPOOF_SEED__;
	return typeof defined === "string" ? defined : DEV_SPOOF_SEED;
}
