// src/core/spoof.ts
/**
 * Deterministic identifier spoofing — Appendix H.8 `deriveToken` with the
 * seed passed explicitly. Runtime-safe and dependency-free: the build-time
 * generator (`src/pagescript`) and the ISOLATED-world content script both
 * call it with the same `__SL_SPOOF_SEED__` and purpose (see
 * `SPOOF_PURPOSES` in `@core/constants`) so they agree on every token without
 * communicating.
 */

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Substrings a spoofed token must never contain (product names, old and new). */
const FORBIDDEN = ["sliced", "tranquill"];

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
