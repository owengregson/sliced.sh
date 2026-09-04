/**
 * Seeded PRNG: xoshiro128** seeded via splitmix32 (numbers) or FNV-1a → splitmix32
 * (strings). Deterministic per seed; the only randomness source in `src/`.
 */

export interface Rng {
	/** Uniform float in [0, 1). */
	next(): number;
	/** Uniform integer in [min, max] (both inclusive). */
	int(min: number, max: number): number;
	/** Gaussian sample (Box–Muller). */
	normal(mu?: number, sigma?: number): number;
	/** exp(normal(mu, sigma)). */
	logNormal(mu?: number, sigma?: number): number;
	/** Uniform element; throws on an empty array. */
	pick<T>(items: readonly T[]): T;
	/** True with probability `p`. */
	chance(p: number): boolean;
	/** Element chosen in proportion to `weights`; throws on mismatch or non-positive total. */
	weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

function fnv1a32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function splitmix32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x9e3779b9) | 0;
		let t = a ^ (a >>> 16);
		t = Math.imul(t, 0x21f0aaad);
		t ^= t >>> 15;
		t = Math.imul(t, 0x735a2d97);
		return (t ^ (t >>> 15)) >>> 0;
	};
}

function rotl(x: number, k: number): number {
	return (x << k) | (x >>> (32 - k));
}

export function createRng(seed: number | string): Rng {
	const base = typeof seed === "string" ? fnv1a32(seed) : Math.floor(seed);
	const mix = splitmix32(base);
	let s0 = mix();
	let s1 = mix();
	let s2 = mix();
	let s3 = mix();
	if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

	const nextU32 = (): number => {
		const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
		const t = s1 << 9;
		s2 ^= s0;
		s3 ^= s1;
		s1 ^= s2;
		s0 ^= s3;
		s2 ^= t;
		s3 = rotl(s3, 11);
		return result;
	};

	const next = (): number => nextU32() / 4294967296;

	const normal = (mu = 0, sigma = 1): number => {
		const u1 = 1 - next();
		const u2 = next();
		return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	};

	return {
		next,
		int(min, max) {
			const lo = Math.ceil(min);
			const hi = Math.floor(max);
			if (hi < lo) throw new RangeError(`rng.int: empty range [${min}, ${max}]`);
			return lo + Math.floor(next() * (hi - lo + 1));
		},
		normal,
		logNormal: (mu = 0, sigma = 1) => Math.exp(normal(mu, sigma)),
		pick(items) {
			if (items.length === 0) throw new RangeError("rng.pick: empty array");
			const item = items[Math.floor(next() * items.length)];
			if (item === undefined) throw new RangeError("rng.pick: index out of range");
			return item;
		},
		chance: (p) => (p >= 1 ? true : p <= 0 ? false : next() < p),
		weighted(items, weights) {
			if (items.length === 0 || items.length !== weights.length)
				throw new RangeError("rng.weighted: items/weights length mismatch");
			let total = 0;
			for (const w of weights) {
				if (!(w >= 0)) throw new RangeError("rng.weighted: negative or NaN weight");
				total += w;
			}
			if (total <= 0) throw new RangeError("rng.weighted: total weight must be positive");
			let r = next() * total;
			let last = 0;
			for (let i = 0; i < weights.length; i++) {
				const w = weights[i] ?? 0;
				if (w <= 0) continue;
				last = i;
				if (r < w) break;
				r -= w;
			}
			const chosen = items[last];
			if (chosen === undefined) throw new RangeError("rng.weighted: index out of range");
			return chosen;
		},
	};
}
