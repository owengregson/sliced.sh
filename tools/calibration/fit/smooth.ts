/**
 * tools/calibration/fit/smooth.ts — the joint choice of one evaluated point per cell: a monotone
 * Viterbi pass over a time class's buckets (objective + prior + smoothness, the conditioning never
 * decreasing with the target).
 */

import type { MaiaCalibrationTimeClass } from "@core/constants/maia-calibration";
import type { CellSurface, SurfacePoint } from "./surface";

/**
 * The joint choice's penalties. Conditioning and temperature trade off (both move strength), so
 * a cell's surface has a valley of statistically equivalent points; these pick one point per cell,
 * all of them actually evaluated:
 *
 *   - `prior`: `((Δ / elo)² + ((T − 1) / temperature)²)` — the least departure from Maia as
 *     advertised (condition at the target, T = 1) among near-equivalent points; one χ² unit for
 *     400 Elo or 0.4 in T, so it only decides inside the valley;
 *   - `smooth`: between neighbouring buckets, the conditioning step's departure from the buckets'
 *     own spacing and the temperature step, in the same units;
 *   - the conditioning never decreases with the target (a hard constraint).
 */
export const JOINT = {
	prior: { elo: 400, temperature: 0.4, weight: 0.25 },
	smooth: { elo: 300, temperature: 0.2, weight: 12 },
	/** Cells with fewer fit games than this are left out (the edge knots extrapolate over them). */
	minGames: 20,
} as const;

export interface Pick {
	tc: MaiaCalibrationTimeClass;
	bucket: number;
	conditioning: number;
	temperature: number;
	point: SurfacePoint;
	minObjective: number;
	surface: CellSurface;
}

/**
 * The cheapest monotone path through the cells' evaluated points (Viterbi over buckets):
 * Σ objective + prior + smoothness, subject to non-decreasing conditioning.
 */
export function smoothClass(
	surfaces: readonly CellSurface[],
	smoothWeight: number = JOINT.smooth.weight
): Pick[] {
	const cells = surfaces
		.filter((s) => s.games >= JOINT.minGames)
		.sort((a, b) => a.bucket - b.bucket);
	if (cells.length === 0) return [];
	const P = JOINT.prior;
	const S = JOINT.smooth;
	const local = (p: SurfacePoint): number =>
		p.objective + P.weight * ((p.offset / P.elo) ** 2 + ((p.temperature - 1) / P.temperature) ** 2);
	const step = (a: CellSurface, pa: SurfacePoint, b: CellSurface, pb: SurfacePoint): number => {
		const ca = a.bucket + pa.offset;
		const cb = b.bucket + pb.offset;
		if (cb < ca) return Number.POSITIVE_INFINITY;
		const spacing = b.bucket - a.bucket;
		return (
			smoothWeight *
			(((cb - ca - spacing) / S.elo) ** 2 + ((pb.temperature - pa.temperature) / S.temperature) ** 2)
		);
	};
	const first = cells[0] as CellSurface;
	let cost = first.points.map((p) => local(p));
	const back: number[][] = [];
	for (let i = 1; i < cells.length; i++) {
		const prev = cells[i - 1] as CellSurface;
		const cur = cells[i] as CellSurface;
		const next: number[] = [];
		const from: number[] = [];
		for (const pb of cur.points) {
			let best = Number.POSITIVE_INFINITY;
			let arg = 0;
			for (const [j, pa] of prev.points.entries()) {
				const c = (cost[j] as number) + step(prev, pa, cur, pb);
				if (c < best) {
					best = c;
					arg = j;
				}
			}
			next.push(best + local(pb));
			from.push(arg);
		}
		cost = next;
		back.push(from);
	}
	let j = cost.indexOf(Math.min(...cost));
	const chosen: number[] = [j];
	for (let i = back.length - 1; i >= 0; i--) {
		j = (back[i] as number[])[j] as number;
		chosen.unshift(j);
	}
	return cells.map((s, i) => {
		const point = s.points[chosen[i] as number] as SurfacePoint;
		return {
			tc: s.tc,
			bucket: s.bucket,
			conditioning: s.bucket + point.offset,
			temperature: point.temperature,
			point,
			minObjective: Math.min(...s.points.map((p) => p.objective)),
			surface: s,
		};
	});
}
