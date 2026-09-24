/**
 * tools/timing-calibration/common/bands.ts — the cell keys and the thresholds: rating bands (100-
 * and 400-Elo), time-control groups, the control-string parser, and the premove and low-clock
 * limits.
 */

export type TimeClass = "bullet" | "blitz" | "rapid";

/** chess.com records a premove as a 0.1 s tick: a think at or under this is a premove. */
export const PREMOVE_MAX_MS = 200;
/** Own clock under this fraction of the base, or under `LOW_CLOCK_MS`, is "low clock". */
export const LOW_CLOCK_FRACTION = 0.1;
export const LOW_CLOCK_MS = 10_000;

/** 100-Elo rating bands, 600 … 3000 (3000 = "3000+"; below 600 → 600). */
export const BAND_WIDTH = 100;
export const BAND_MIN = 600;
export const BAND_MAX = 3000;
export function bandOf(rating: number): number {
	const b = Math.floor(rating / BAND_WIDTH) * BAND_WIDTH;
	return Math.min(BAND_MAX, Math.max(BAND_MIN, b));
}

/** Wider bands for reporting (400-Elo: 600, 1000, …, 2600, 3000+). */
export function wideBandOf(rating: number): number {
	if (rating >= 3000) return 3000;
	if (rating < 1000) return 600;
	return 1000 + Math.floor((rating - 1000) / 400) * 400;
}

/**
 * The reporting group of a time control: the class, with rapid split by control (10+0, 15+10,
 * 10+5 mix very different paces) and other rapid controls pooled.
 */
export function tcGroupOf(tc: TimeClass, control: string): string {
	if (tc !== "rapid") return tc;
	if (control === "600" || control === "900+10" || control === "600+5") return `rapid:${control}`;
	return "rapid:other";
}

export const TC_GROUPS = ["bullet", "blitz", "rapid:600", "rapid:600+5", "rapid:900+10"] as const;

/** `"180+2"` → base 180 s, increment 2 s; `"60"` → 60 + 0; null for daily or junk. */
export function parseControl(tc: string): { baseS: number; incS: number } | null {
	const m = /^(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(tc.trim());
	if (!m) return null;
	return { baseS: Number(m[1]), incS: m[2] !== undefined ? Number(m[2]) : 0 };
}
