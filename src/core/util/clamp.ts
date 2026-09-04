export function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

/** Round to the nearest integer, then clamp. */
export function clampInt(n: number, min: number, max: number): number {
	return clamp(Math.round(n), min, max);
}
