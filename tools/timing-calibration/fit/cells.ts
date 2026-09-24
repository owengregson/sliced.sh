/**
 * tools/timing-calibration/fit/cells.ts — one replay summarised per fitting cell (time class ×
 * 400-Elo band × situation × split): the human and bot quantiles and premove counts, and the
 * per-cell objective `n_eff · Σ_q w_q (ln bot_q − ln human_q)²`.
 */

import type { TimingCalibrationTimeClass } from "@core/constants/timing-calibration";
import { PREMOVE_MAX_MS, wideBandOf } from "../common";
import { type ReplayData, type SimOptions, simulate } from "../sim";
import { quantileSorted } from "../stats";

export const KNOTS = [800, 1200, 1600, 2000, 2400, 2800, 3100] as const;
export const BANDS = [600, 1000, 1400, 1800, 2200, 2600, 3000] as const;
export const CLASSES: readonly TimingCalibrationTimeClass[] = ["bullet", "blitz", "rapid"];
export const SPLITS = ["fit", "holdout", "all"] as const;
export type SplitKey = (typeof SPLITS)[number];
export const P0 = 0.5;
export const MIN_CELL = 25;
export const N_EFF_MAX = 300;
const Q = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
const QW = [0.5, 1, 1, 1, 0.5] as const;

export const classOf = (tcGroup: string): TimingCalibrationTimeClass =>
	tcGroup.startsWith("rapid") ? "rapid" : (tcGroup as TimingCalibrationTimeClass);

/** Per cell: human and bot sorted thinks (ms) and premove counts. */
export interface CellStats {
	humanQ: number[];
	botQ: number[];
	humanN: number;
	botN: number;
	humanPremove: number;
	botPremove: number;
}

export type CellMap = Record<string, CellStats>;

export function cellKey(cls: string, band: number, situation: string, split: string): string {
	return `${cls}|${band}|${situation}|${split}`;
}

/** Replay once and summarise every cell for every split (and "recapture-premove" pools). */
export async function measure(
	data: ReplayData,
	opts: SimOptions,
	only?: TimingCalibrationTimeClass
): Promise<CellMap> {
	const results = await simulate(data, opts, (s) =>
		only === undefined ? true : classOf(s.rows[0]?.row.tcGroup ?? "") === only
	);
	const pools = new Map<string, { h: number[]; b: number[] }>();
	for (const side of data.sides) {
		for (const rr of side.rows) {
			const res = results.get(rr.row.id);
			if (!res) continue;
			const r = rr.row;
			const cls = classOf(r.tcGroup);
			const band = wideBandOf(r.rating);
			for (const split of [side.split, "all"]) {
				const key = cellKey(cls, band, r.situation, split);
				const pool = pools.get(key) ?? { h: [], b: [] };
				pool.h.push(r.thinkMs);
				for (const ms of res.bot) pool.b.push(ms);
				pools.set(key, pool);
			}
		}
	}
	const out: CellMap = {};
	for (const [key, { h, b }] of pools) {
		const hs = h.sort((x, y) => x - y);
		const bs = b.sort((x, y) => x - y);
		out[key] = {
			humanQ: Q.map((q) => quantileSorted(hs, q)),
			botQ: Q.map((q) => quantileSorted(bs, q)),
			humanN: hs.length,
			botN: bs.length,
			humanPremove: hs.filter((v) => v <= PREMOVE_MAX_MS).length,
			botPremove: bs.filter((v) => v <= PREMOVE_MAX_MS).length,
		};
	}
	return out;
}

export function objective(c: CellStats | undefined): number {
	if (!c || c.humanN < MIN_CELL) return 0;
	const nEff = Math.min(c.humanN, N_EFF_MAX);
	let s = 0;
	for (let i = 0; i < Q.length; i++) {
		const h = Math.max(100, c.humanQ[i] ?? 100);
		const b = Math.max(100, c.botQ[i] ?? 100);
		s += (QW[i] ?? 1) * Math.log(b / h) ** 2;
	}
	return nEff * s;
}
