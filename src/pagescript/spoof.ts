// src/pagescript/spoof.ts
/**
 * Deterministic identifier spoofing (§5.4). Ports Appendix H.8 `deriveToken`
 * with the seed passed explicitly instead of read from a global, so the same
 * derivation can run at build time (generator), in tests, and — if a later
 * task needs it — in the ISOLATED world with `__SL_SPOOF_SEED__`.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4).
 */

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Substrings a spoofed token must never contain (product names, old and new). */
const FORBIDDEN = ["sliced", "tranquill"];

/** Fixed seed used when no build seed is supplied (dev / standalone runs). */
export const DEV_SPOOF_SEED = "dev-seed-0000000000000000000000";

/** FNV-1a (32-bit) of a string → unsigned integer. */
function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function derive(seed: string, purpose: string, length: number): string {
	let state = fnv1a(`${seed}:${purpose}`);
	let out = ALPHA[state % ALPHA.length] ?? "";
	for (let i = 1; i < length; i++) {
		// xorshift32
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		out += ALPHANUM[state % ALPHANUM.length];
	}
	return out;
}

/**
 * Deterministic, CSS-safe, identifier-safe token from a build seed and a
 * purpose label: identical inputs give the identical token within and across
 * processes, different seeds give unrelated tokens. Starts with a letter,
 * lowercase alphanumeric throughout. In the (astronomically unlikely) event
 * the derived token contains a product-name substring the purpose is salted
 * and re-derived, so the result is still deterministic.
 */
export function deriveToken(seed: string, purpose: string, length = 12): string {
	if (!Number.isInteger(length) || length < 1) {
		throw new RangeError(`deriveToken: length must be a positive integer, got ${length}`);
	}
	let token = derive(seed, purpose, length);
	for (let salt = 1; FORBIDDEN.some((f) => token.includes(f)); salt++) {
		token = derive(seed, `${purpose}#${salt}`, length);
	}
	return token;
}

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
