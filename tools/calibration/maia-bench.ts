/**
 * tools/calibration/maia-bench.ts — throughput of the native batch path over worker / thread /
 * batch configurations, and the smoothness of Maia in its self-Elo input (log-linear
 * interpolation error between grid points), which sets the harness's Elo grid step.
 *
 *   bun tools/calibration/maia-bench.ts throughput [--configs 3x2x32+1,4x2x32+0,...] [--queries N]
 *   bun tools/calibration/maia-bench.ts smoothness [--positions 40] [--seed 7]
 */

import "../lib/defines";
import path from "node:path";
import {
	createMaiaGridPool,
	type MaiaGridPolicy,
	type MaiaGridRequest,
	maiaGrid,
} from "./maia-batch";

const ROOT = path.resolve(import.meta.dir, "../..");

interface FixturePosition {
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
}

async function fixture(): Promise<FixturePosition[]> {
	const f = (await Bun.file(path.join(ROOT, "test/fixtures/maia3/positions.json")).json()) as {
		positions: FixturePosition[];
	};
	return f.positions;
}

function argValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

async function throughput(args: string[]): Promise<void> {
	const positions = await fixture();
	const configs = (
		argValue(args, "--configs") ??
		"3x2x32+0,0x1x32+1,1x2x32+1,2x2x32+1,3x2x32+1,4x2x32+1,2x3x32+1,6x1x32+1,3x2x16+1,3x2x64+1"
	).split(",");
	const target = Number(argValue(args, "--queries") ?? 3000);
	const elosPer = 12;
	const perRound = positions.length * elosPer;
	const rounds = Math.max(1, Math.round(target / perRound));
	// Distinct ids/elos per round so nothing is cached anywhere.
	const requests: MaiaGridRequest[] = [];
	for (let r = 0; r < rounds; r++)
		positions.forEach((p, i) => {
			requests.push({
				id: `${r}:${i}`,
				historyFens: p.historyFens,
				oppoElo: p.oppoElo,
				selfElos: Array.from({ length: elosPer }, (_, k) => 600 + 200 * k + r),
			});
		});
	const total = requests.length * elosPer;
	console.log(
		`throughput: ${total} queries per configuration (CPU workers x threads x batch + CoreML workers)`
	);
	for (const config of configs) {
		const [cpu = "", g = "0"] = config.split("+");
		const [w, t, b] = cpu.split("x").map(Number);
		const pool = await createMaiaGridPool({
			workers: w ?? 0,
			threads: t ?? 1,
			batch: b ?? 32,
			coremlWorkers: Number(g),
		});
		await pool.run(requests.slice(0, pool.workers * 4)); // warm every worker's session
		const start = performance.now();
		await pool.run(requests);
		const secs = (performance.now() - start) / 1000;
		await pool.close();
		console.log(`  ${config.padEnd(8)} ${(total / secs).toFixed(1).padStart(7)} q/s`);
	}
}

/** Mulberry32. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Log-linear interpolation of two policies over the same legal set at fraction `f`, renormalised. */
function interpolate(a: MaiaGridPolicy, b: MaiaGridPolicy, f: number): Map<string, number> {
	const pb = new Map(b.moves);
	const out = new Map<string, number>();
	let sum = 0;
	for (const [uci, pa] of a.moves) {
		const q = pb.get(uci) ?? 0;
		const w = Math.exp((1 - f) * Math.log(Math.max(pa, 1e-30)) + f * Math.log(Math.max(q, 1e-30)));
		out.set(uci, w);
		sum += w;
	}
	for (const [k, v] of out) out.set(k, v / sum);
	return out;
}

function tv(exact: MaiaGridPolicy, approx: Map<string, number>): number {
	let d = 0;
	for (const [uci, p] of exact.moves) d += Math.abs(p - (approx.get(uci) ?? 0));
	return d / 2;
}

async function smoothness(args: string[]): Promise<void> {
	const all = await fixture();
	const count = Number(argValue(args, "--positions") ?? 40);
	const random = rng(Number(argValue(args, "--seed") ?? 7));
	const order = all.map((_, i) => i);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[order[i], order[j]] = [order[j] ?? 0, order[i] ?? 0];
	}
	const picked = order.slice(0, count).map((i) => all[i] as FixturePosition);
	const lo = 600;
	const hi = 3200;
	const elos: number[] = [];
	for (let e = lo; e <= hi; e += 50) elos.push(e);
	const results = await maiaGrid(
		picked.map((p, i) => ({
			id: String(i),
			historyFens: p.historyFens,
			oppoElo: p.oppoElo,
			selfElos: elos,
		})),
		{ workers: 3, threads: 2, batch: 32, coremlWorkers: 1 }
	);
	const at = (policies: MaiaGridPolicy[], e: number): MaiaGridPolicy => {
		const p = policies.find((x) => x.selfElo === e);
		if (!p) throw new Error(`no policy at ${e}`);
		return p;
	};
	interface Row {
		step: number;
		offset: number;
		band: string;
		tvs: number[];
		nearest: number[];
	}
	const rows: Row[] = [];
	const bands: Array<[string, number, number]> = [
		["600-1200", 600, 1200],
		["1200-2000", 1200, 2000],
		["2000-2600", 2000, 2600],
		["2600-3200", 2600, 3200],
		["all", 600, 3200],
	];
	for (const step of [100, 200]) {
		for (const offset of step === 100 ? [50] : [50, 100]) {
			for (const [band, bLo, bHi] of bands) {
				const row: Row = { step, offset, band, tvs: [], nearest: [] };
				for (let e = lo; e + step <= hi; e += step) {
					if (e < bLo || e + step > bHi) continue;
					for (const r of results) {
						const a = at(r.policies, e);
						const b = at(r.policies, e + step);
						const exact = at(r.policies, e + offset);
						row.tvs.push(tv(exact, interpolate(a, b, offset / step)));
						row.nearest.push(tv(exact, new Map(offset * 2 <= step ? a.moves : b.moves)));
					}
				}
				rows.push(row);
			}
		}
	}
	const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
	const max = (xs: number[]): number => xs.reduce((m, x) => Math.max(m, x), 0);
	const p99 = (xs: number[]): number => {
		const s = [...xs].sort((x, y) => x - y);
		return s[Math.min(s.length - 1, Math.floor(0.99 * s.length))] ?? 0;
	};
	console.log(
		`smoothness: ${picked.length} positions, exact Elo ${lo}..${hi} step 50, TV(exact, log-linear interpolation)`
	);
	console.log(
		"| step | point | band | n | mean TV | p99 TV | max TV | nearest-grid mean TV | nearest max TV |"
	);
	console.log("|---:|---|---|---:|---:|---:|---:|---:|---:|");
	for (const r of rows)
		console.log(
			`| ${r.step} | e+${r.offset} | ${r.band} | ${r.tvs.length} | ${mean(r.tvs).toFixed(4)} | ${p99(r.tvs).toFixed(4)} | ${max(r.tvs).toFixed(4)} | ${mean(r.nearest).toFixed(4)} | ${max(r.nearest).toFixed(4)} |`
		);
}

if (import.meta.main) {
	const [mode, ...rest] = process.argv.slice(2);
	if (mode === "throughput") await throughput(rest);
	else if (mode === "smoothness") await smoothness(rest);
	else {
		console.error("usage: bun tools/calibration/maia-bench.ts throughput|smoothness [...]");
		process.exit(2);
	}
}
