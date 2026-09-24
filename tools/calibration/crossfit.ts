/**
 * tools/calibration/crossfit.ts — combine the two cross-fitting directions into one verdict.
 *
 * Direction A fits the table and the rating model on the `fit` players and verifies on `holdout`;
 * direction B the reverse. Every player is then verified exactly once by a table and a model that
 * never saw them. Per cell, the two "plays at − R" gaps are combined by inverse variance, and the
 * loss metrics' z-scores are pooled as `(z_A + z_B)/√2`. The shipped table is fitted on all players
 * (`fit.ts --split all`); the cross-fit numbers are its out-of-sample accuracy (slightly
 * conservative: each direction's table saw half the players).
 *
 *   bun tools/calibration/crossfit.ts --a LABEL_A --b LABEL_B [--out FILE.md]
 */

import "../lib/defines";
import path from "node:path";
import { flagOr } from "../lib/cli";
import { DATA_DIR } from "./common";

interface Summary {
	cells: Array<{
		tc: string;
		bucket: number;
		human: Record<string, { n: number }>;
		z: Record<string, number>;
	}>;
	rating: Record<string, { implied: number; diffSe: number; games: number } | null>;
}

const LOSS = ["epl", "inacc", "mistake", "blunder"] as const;

export interface CrossCell {
	key: string;
	bucket: number;
	gap: number;
	se: number;
	games: number;
	lossZ: Record<string, number>;
}

export function combine(a: Summary, b: Summary): CrossCell[] {
	const out: CrossCell[] = [];
	for (const [key, ra] of Object.entries(a.rating)) {
		const rb = b.rating[key];
		const bucket = Number(key.split(":")[1]);
		const parts = [ra, rb].filter(
			(r): r is { implied: number; diffSe: number; games: number } =>
				r !== null && r !== undefined && r.diffSe > 0 && Number.isFinite(r.diffSe)
		);
		if (parts.length === 0) continue;
		let wSum = 0;
		let gSum = 0;
		for (const r of parts) {
			const w = 1 / r.diffSe ** 2;
			wSum += w;
			gSum += w * (r.implied - bucket);
		}
		const ca = a.cells.find((c) => `${c.tc}:${c.bucket}` === key);
		const cb = b.cells.find((c) => `${c.tc}:${c.bucket}` === key);
		const lossZ: Record<string, number> = {};
		for (const m of LOSS) {
			const zs = [ca, cb]
				.filter((c) => c !== undefined && (c.human.blunder?.n ?? 0) > 0)
				.map((c) => c?.z[m] ?? 0);
			lossZ[m] = zs.length ? zs.reduce((s, z) => s + z, 0) / Math.sqrt(zs.length) : 0;
		}
		out.push({
			key,
			bucket,
			gap: gSum / wSum,
			se: Math.sqrt(1 / wSum),
			games: parts.reduce((s, r) => s + r.games, 0),
			lossZ,
		});
	}
	return out.sort((x, y) =>
		x.key.split(":")[0] === y.key.split(":")[0] ? x.bucket - y.bucket : x.key < y.key ? -1 : 1
	);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const dir = path.join(DATA_DIR, "verify");
	const la = flagOr(argv, "a", "crossA");
	const lb = flagOr(argv, "b", "crossB");
	const a = (await Bun.file(path.join(dir, la, "summary.json")).json()) as Summary;
	const b = (await Bun.file(path.join(dir, lb, "summary.json")).json()) as Summary;
	const cells = combine(a, b);
	const within = cells.filter((c) => Math.abs(c.gap) <= 1.96 * c.se).length;
	let lossOk = 0;
	let lossN = 0;
	for (const c of cells)
		for (const m of LOSS) {
			lossN++;
			if (Math.abs(c.lossZ[m] ?? 0) <= 2) lossOk++;
		}
	const z = cells.map((c) => c.gap / c.se);
	const mean = z.reduce((s, v) => s + v, 0) / z.length;
	const sd = Math.sqrt(z.reduce((s, v) => s + (v - mean) ** 2, 0) / z.length);
	const lines = [
		`# Cross-fitted verification (${la} + ${lb})`,
		"",
		`Every player verified once, by a table and a rating model fitted on the other half. ${within}/${cells.length} cells play within the 95 % interval of their target; ${lossOk}/${lossN} pooled loss metrics |z| ≤ 2; gap z mean ${mean.toFixed(2)}, SD ${sd.toFixed(2)}; median ±1.96 SE ${Math.round(1.96 * ([...cells].map((c) => c.se).sort((x, y) => x - y)[Math.floor(cells.length / 2)] ?? 0))} Elo.`,
		"",
		"| cell | games | plays at − target | ± 1.96 SE | within | EPL z | blunder z |",
		"|---|---:|---:|---:|:-:|---:|---:|",
		...cells.map(
			(c) =>
				`| ${c.key} | ${c.games} | ${c.gap >= 0 ? "+" : ""}${Math.round(c.gap)} | ${Math.round(1.96 * c.se)} | ${Math.abs(c.gap) <= 1.96 * c.se ? "✓" : "✗"} | ${(c.lossZ.epl ?? 0).toFixed(1)} | ${(c.lossZ.blunder ?? 0).toFixed(1)} |`
		),
		"",
	];
	const out = flagOr(argv, "out", path.join(dir, `crossfit-${la}-${lb}.md`));
	await Bun.write(out, lines.join("\n"));
	console.log(lines.join("\n"));
}

if (import.meta.main) await main();
