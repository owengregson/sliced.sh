/**
 * tools/calibration/synth-corpus.ts — a small **synthetic** corpus + policy grid for exercising
 * `frames.ts` before the real chess.com corpus exists. Nothing here is data.
 *
 * Source: the 60 positions of `test/fixtures/strength/maia-draw.json`, each emitted once per
 * time-control class (180 rows). The "grid" is the fixture's two real Maia answers (5M at the
 * position's selfElo, 23M labelled selfElo + 200); the human move is a seeded draw from the 5M
 * policy, replaced by a uniformly random legal move one time in five so `humanLine` gets exercised.
 *
 *   bun tools/calibration/synth-corpus.ts [--out-dir data/calibration/synthetic] [--tcs bullet,blitz,rapid]
 */

import "../human-match/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { legalMoves } from "@core/chess/san";
import { createRng } from "@core/rng";
import { ROOT } from "../human-match/engine";
import type { CalibrationRow, GridPolicy, PolicyRecord, TcClass } from "./frames";

interface FixturePosition {
	index: number;
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	ply: number;
	policy: Partial<
		Record<"5m" | "23m", { moves: Array<[string, number]>; wdl: [number, number, number] }>
	>;
}

const TC_CLOCK: Readonly<Record<TcClass, { baseMs: number; incrementMs: number }>> = {
	bullet: { baseMs: 60_000, incrementMs: 0 },
	blitz: { baseMs: 180_000, incrementMs: 0 },
	rapid: { baseMs: 600_000, incrementMs: 0 },
};

export function bucketFor(elo: number): number {
	return Math.min(3000, Math.max(600, Math.round(elo / 200) * 200));
}

export async function synthesise(
	tcs: readonly TcClass[] = ["bullet", "blitz", "rapid"],
	limit = 0
): Promise<{ rows: CalibrationRow[]; policies: PolicyRecord[] }> {
	const file = (await Bun.file(path.join(ROOT, "test/fixtures/strength/maia-draw.json")).json()) as {
		positions: FixturePosition[];
	};
	const source = limit > 0 ? file.positions.slice(0, limit) : file.positions;
	const rng = createRng("calibration:synthetic");
	const rows: CalibrationRow[] = [];
	const policies: PolicyRecord[] = [];
	for (const tc of tcs) {
		for (const p of source) {
			const id = `synth-${tc}:${p.index}`;
			const grid: GridPolicy[] = [];
			const small = p.policy["5m"];
			const mid = p.policy["23m"];
			if (small) grid.push({ selfElo: p.selfElo, moves: small.moves, wdl: small.wdl });
			if (mid) grid.push({ selfElo: p.selfElo + 200, moves: mid.moves, wdl: mid.wdl });
			const legal = legalMoves(p.fen);
			const humanMove =
				small && rng.next() >= 0.2
					? rng.weighted(
							small.moves.map(([uci]) => uci),
							small.moves.map(([, q]) => q)
						)
					: (legal[Math.floor(rng.next() * legal.length)] ?? "");
			const clock = TC_CLOCK[tc];
			rows.push({
				id,
				gameId: `synth-${tc}`,
				ply: p.ply,
				fen: p.fen,
				historyFens: p.historyFens,
				selfElo: p.selfElo,
				oppoElo: p.oppoElo,
				humanMove,
				clockMs: clock.baseMs / 2,
				oppClockMs: clock.baseMs / 2,
				baseMs: clock.baseMs,
				incrementMs: clock.incrementMs,
				tc,
				bucket: bucketFor(p.selfElo),
				player: "synthetic",
				color: p.fen.split(" ")[1] === "b" ? "b" : "w",
				split: p.index % 5 === 0 ? "holdout" : "fit",
			});
			policies.push({ id, policies: grid });
		}
	}
	return { rows, policies };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let outDir = path.join(ROOT, "data/calibration/synthetic");
	let tcs: TcClass[] = ["bullet", "blitz", "rapid"];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out-dir") outDir = argv[++i] ?? outDir;
		else if (argv[i] === "--tcs") tcs = (argv[++i] ?? "").split(",") as TcClass[];
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	mkdirSync(outDir, { recursive: true });
	const { rows, policies } = await synthesise(tcs);
	const jsonl = (xs: unknown[]): string => `${xs.map((x) => JSON.stringify(x)).join("\n")}\n`;
	await Bun.write(path.join(outDir, "corpus.jsonl"), jsonl(rows));
	await Bun.write(path.join(outDir, "policies.jsonl"), jsonl(policies));
	console.log(`wrote ${rows.length} rows to ${outDir}/{corpus,policies}.jsonl`);
}

if (import.meta.main) await main();
