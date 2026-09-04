// test/pagescript/spoof.test.ts
import { describe, expect, it } from "bun:test";
import { deriveToken } from "@core/spoof";
import { DEV_SPOOF_SEED, deriveToken as reexported, resolveSpoofSeed } from "@pagescript/spoof";

const IDENT = /^[a-z][a-z0-9]*$/;

describe("deriveToken", () => {
	it("is the runtime-safe @core/spoof implementation, re-exported for the emitter", () => {
		expect(reexported).toBe(deriveToken);
	});

	it("is deterministic per (seed, purpose)", () => {
		expect(deriveToken("seed-a", "ready")).toBe(deriveToken("seed-a", "ready"));
		expect(deriveToken("seed-a", "ready")).not.toBe(deriveToken("seed-b", "ready"));
		expect(deriveToken("seed-a", "ready")).not.toBe(deriveToken("seed-a", "other"));
	});

	it("matches the reference derivation (fnv1a + xorshift32 over seed:purpose)", () => {
		// Independent re-implementation of Appendix H.8 with the seed passed explicitly.
		const ALPHA = "abcdefghijklmnopqrstuvwxyz";
		const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";
		const ref = (seed: string, purpose: string, length = 12): string => {
			const s = `${seed}:${purpose}`;
			let h = 0x811c9dc5;
			for (let i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 0x01000193);
			}
			let state = h >>> 0;
			let out = ALPHA[state % ALPHA.length] ?? "";
			for (let i = 1; i < length; i++) {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				state >>>= 0;
				out += ALPHANUM[state % ALPHANUM.length];
			}
			return out;
		};
		for (const [seed, purpose] of [
			["deadbeef01234567deadbeef01234567", "ready"],
			["s1", "msgKey"],
			["", ""],
			["unicode-ß", "purpose/with:punct"],
		] as const) {
			expect(deriveToken(seed, purpose)).toBe(ref(seed, purpose));
		}
		expect(deriveToken("s", "p", 6)).toBe(ref("s", "p", 6));
	});

	it("produces a valid, lowercase JS identifier of the requested length", () => {
		for (let i = 0; i < 500; i++) {
			const t = deriveToken("seed", `purpose-${i}`);
			expect(t).toMatch(IDENT);
			expect(t).toHaveLength(12);
		}
		expect(deriveToken("seed", "x", 20)).toHaveLength(20);
	});

	it("never contains a product-name substring", () => {
		for (let i = 0; i < 2000; i++) {
			const t = deriveToken(`seed-${i % 7}`, `purpose-${i}`);
			expect(t).not.toContain("sliced");
			expect(t).not.toContain("tranquill");
		}
	});

	it("rejects a length that cannot produce an identifier", () => {
		expect(() => deriveToken("s", "p", 0)).toThrow(RangeError);
	});
});

describe("resolveSpoofSeed", () => {
	it("prefers the explicit seed, then the build define, then the fixed dev seed", () => {
		expect(resolveSpoofSeed("explicit")).toBe("explicit");
		// test/setup.ts installs the build define on globalThis.
		expect(resolveSpoofSeed()).toBe("deadbeef01234567deadbeef01234567");
		const g = globalThis as Record<string, unknown>;
		const saved = g.__SL_SPOOF_SEED__;
		delete g.__SL_SPOOF_SEED__;
		try {
			expect(resolveSpoofSeed()).toBe(DEV_SPOOF_SEED);
		} finally {
			g.__SL_SPOOF_SEED__ = saved;
		}
	});
});
