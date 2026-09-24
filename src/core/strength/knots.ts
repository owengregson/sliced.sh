/** Piecewise-linear lookup over `[x, y]` knot tables, shared by the rating curves. */

/**
 * `y` at `x` over ascending `[x, y]` knots: flat outside the table, linear between neighbours.
 * `empty` answers for a table with no knots.
 */
export function interpolateKnots(
	x: number,
	knots: ReadonlyArray<readonly [number, number]>,
	empty: number
): number {
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (first === undefined || last === undefined) return empty;
	if (x <= first[0]) return first[1];
	if (x >= last[0]) return last[1];
	for (let i = 1; i < knots.length; i++) {
		const lo = knots[i - 1];
		const hi = knots[i];
		if (lo === undefined || hi === undefined) continue;
		if (x <= hi[0]) {
			const t = (x - lo[0]) / (hi[0] - lo[0]);
			return lo[1] + t * (hi[1] - lo[1]);
		}
	}
	return last[1];
}
