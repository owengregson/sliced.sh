/**
 * tools/lib/random.ts — the small deterministic generators the research tools seed by hand:
 * mulberry32 (a crawl's visiting order, a benchmark's shuffle) and FNV-1a (a stable per-id
 * subsample order). `@core/rng` is the product's generator; these reproduce the tools' own
 * historical streams.
 */

/** Mulberry32: a uniform float stream in [0, 1) from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** FNV-1a, 32 bit. */
export function hash32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}
