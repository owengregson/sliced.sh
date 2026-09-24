/**
 * tools/calibration/sim/policy-grid.ts — Maia at any rating from a row's cached grid policies:
 * log-linear interpolation between the neighbouring grid ratings, clamped to the grid's ends.
 */

import type { PolicyResult } from "@core/policy/types";
import type { GridPolicy } from "../frames/schema";

/** A move a grid answer dropped (stored `p < 1e-5`) counts at this floor when interpolating. */
const MISSING_P = 1e-6;

export class PolicyGrid {
	private readonly grid: GridPolicy[];
	private readonly cache = new Map<number, PolicyResult>();

	constructor(policies: readonly GridPolicy[]) {
		this.grid = [...policies].sort((a, b) => a.selfElo - b.selfElo);
		if (this.grid.length === 0) throw new Error("PolicyGrid: no policies");
	}

	get elos(): number[] {
		return this.grid.map((g) => g.selfElo);
	}

	/** Maia's answer at `elo` (integer, as `maiaConditioningElo` rounds): clamped to the grid ends. */
	at(elo: number): PolicyResult {
		const key = Math.round(elo);
		const hit = this.cache.get(key);
		if (hit) return hit;
		const result = this.interpolate(key);
		this.cache.set(key, result);
		return result;
	}

	private interpolate(elo: number): PolicyResult {
		const g = this.grid;
		const first = g[0] as GridPolicy;
		const last = g[g.length - 1] as GridPolicy;
		let lo = first;
		let hi = first;
		if (elo >= last.selfElo) {
			lo = last;
			hi = last;
		} else if (elo > first.selfElo) {
			for (let i = 1; i < g.length; i++) {
				const next = g[i] as GridPolicy;
				if (elo <= next.selfElo) {
					lo = g[i - 1] as GridPolicy;
					hi = next;
					break;
				}
			}
		}
		const w = hi.selfElo > lo.selfElo ? (elo - lo.selfElo) / (hi.selfElo - lo.selfElo) : 0;
		const wdl = (lo.wdl ?? [1 / 3, 1 / 3, 1 / 3]).map(
			(v, i) => (1 - w) * v + w * ((hi.wdl ?? [1 / 3, 1 / 3, 1 / 3])[i] ?? v)
		) as [number, number, number];
		if (w === 0 || lo === hi) return { moves: lo.moves.map(([u, p]) => [u, p]), wdl, size: "79m" };
		const pLo = new Map(lo.moves);
		const pHi = new Map(hi.moves);
		const ucis = new Set([...pLo.keys(), ...pHi.keys()]);
		const moves: Array<[string, number]> = [];
		let sum = 0;
		for (const u of ucis) {
			const logp = (1 - w) * Math.log(pLo.get(u) ?? MISSING_P) + w * Math.log(pHi.get(u) ?? MISSING_P);
			const p = Math.exp(logp);
			moves.push([u, p]);
			sum += p;
		}
		for (const m of moves) m[1] /= sum;
		moves.sort((a, b) => b[1] - a[1]);
		return { moves, wdl, size: "79m" };
	}
}
