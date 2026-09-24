/**
 * tools/calibration/maia-parity.ts — the native batch path (`maia-batch.ts`) against the shipped
 * wasm path (`createMaiaRunner`, itself proven against torch by `test/integration/maia-onnx.test.ts`).
 *
 * The 60 positions of `test/fixtures/maia3/positions.json`, each at its own self Elo plus
 * `EXTRA_ELOS`, own opponent Elo. Reports max |Δp| over every legal move, max total-variation
 * distance, max |ΔWDL| and argmax agreement; exits 1 unless argmax agrees everywhere and the TV
 * distance stays under `TV_LIMIT`. Slow (~1 min): the wasm side is ~180 ms per query.
 *
 *   bun tools/calibration/maia-parity.ts [--workers N] [--threads T] [--coreml G] [--batch B]
 *
 * `--workers 3 --coreml 0` checks the CPU path alone, `--workers 0 --coreml 1` the CoreML path alone
 */

import "../lib/defines";
import path from "node:path";
import { createMaiaRunner } from "../lib/maia";
import { type MaiaGridOptions, type MaiaGridRequest, maiaGrid } from "./maia-batch";

const ROOT = path.resolve(import.meta.dir, "../..");
const EXTRA_ELOS = [600, 1500, 2500, 3000, 3400];
const TV_LIMIT = 0.01;

interface FixturePosition {
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
}

export interface ParityReport {
	queries: number;
	maxAbsDp: number;
	maxTv: number;
	meanTv: number;
	maxAbsDwdl: number;
	argmaxAgree: number;
	pass: boolean;
}

function argValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

export async function runParity(options: MaiaGridOptions = {}): Promise<ParityReport> {
	const fixture = (await Bun.file(path.join(ROOT, "test/fixtures/maia3/positions.json")).json()) as {
		positions: FixturePosition[];
	};
	const requests: MaiaGridRequest[] = fixture.positions.map((p, i) => ({
		id: String(i),
		historyFens: p.historyFens,
		oppoElo: p.oppoElo,
		selfElos: [p.selfElo, ...EXTRA_ELOS],
	}));
	const native = await maiaGrid(requests, options);
	const runner = await createMaiaRunner(1);
	let queries = 0;
	let maxAbsDp = 0;
	let maxTv = 0;
	let sumTv = 0;
	let maxAbsDwdl = 0;
	let argmaxAgree = 0;
	try {
		for (const [i, request] of requests.entries()) {
			for (const [slot, selfElo] of request.selfElos.entries()) {
				const ref = await runner.query("79m", request.historyFens, selfElo, request.oppoElo);
				const got = native[i]?.policies[slot];
				if (!got || got.selfElo !== selfElo) throw new Error(`missing native policy ${i}/${slot}`);
				const mine = new Map(got.moves);
				if (mine.size !== ref.moves.length) throw new Error(`legal-move sets differ at ${i}`);
				let tv = 0;
				for (const [uci, p] of ref.moves) {
					const q = mine.get(uci);
					if (q === undefined) throw new Error(`move ${uci} missing natively at ${i}`);
					const d = Math.abs(p - q);
					tv += d;
					if (d > maxAbsDp) maxAbsDp = d;
				}
				tv /= 2;
				sumTv += tv;
				if (tv > maxTv) maxTv = tv;
				for (let k = 0; k < 3; k++)
					maxAbsDwdl = Math.max(maxAbsDwdl, Math.abs((ref.wdl[k] ?? 0) - (got.wdl[k] ?? 0)));
				if (ref.moves[0]?.[0] === got.moves[0]?.[0]) argmaxAgree++;
				else
					console.error(
						`argmax differs at #${i} elo ${selfElo}: wasm ${ref.moves[0]?.join("@")} / native ${got.moves[0]?.join("@")} / wasm #2 ${ref.moves[1]?.join("@")}`
					);
				queries++;
			}
		}
	} finally {
		await runner.dispose();
	}
	return {
		queries,
		maxAbsDp,
		maxTv,
		meanTv: sumTv / Math.max(1, queries),
		maxAbsDwdl,
		argmaxAgree,
		pass: argmaxAgree === queries && maxTv < TV_LIMIT,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const options: MaiaGridOptions = {
		workers: Number(argValue(args, "--workers") ?? 3),
		threads: Number(argValue(args, "--threads") ?? 2),
		coremlWorkers: Number(argValue(args, "--coreml") ?? 1),
		batch: Number(argValue(args, "--batch") ?? 32),
	};
	const r = await runParity(options);
	console.log(
		[
			`queries           ${r.queries}`,
			`argmax agreement  ${r.argmaxAgree}/${r.queries}`,
			`max |Δp|          ${r.maxAbsDp.toExponential(3)}`,
			`max TV            ${r.maxTv.toExponential(3)}  (limit ${TV_LIMIT})`,
			`mean TV           ${r.meanTv.toExponential(3)}`,
			`max |ΔWDL|        ${r.maxAbsDwdl.toExponential(3)}`,
			r.pass ? "PASS" : "FAIL",
		].join("\n")
	);
	process.exit(r.pass ? 0 : 1);
}
