/**
 * tools/calibration/shard.ts — join the corpus, the referee frames and the Maia grid policies into
 * one JSONL per cell (`data/calibration/cells/<tc>-<bucket>.jsonl`, one `CellItem` per line), so a
 * fit or verification worker reads its own cell and nothing else.
 *
 *   bun tools/calibration/shard.ts [--corpus F] [--frames F] [--policies F] [--out DIR]
 *
 * A row missing its frame or its policies is left out and counted.
 */

import "../lib/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { flagOr } from "../lib/cli";
import { headId, jsonlLines } from "../lib/jsonl";
import { CELLS_DIR, cellFile } from "./cells";
import { DATA_DIR } from "./common";
import type { CalibrationRow } from "./frames";

export { CELLS_DIR, cellFile };

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const corpusFile = flagOr(argv, "corpus", path.join(DATA_DIR, "corpus.jsonl"));
	const framesFile = flagOr(argv, "frames", path.join(DATA_DIR, "frames.jsonl"));
	const policiesFile = flagOr(argv, "policies", path.join(DATA_DIR, "policies.jsonl"));
	const outDir = flagOr(argv, "out", CELLS_DIR);
	mkdirSync(outDir, { recursive: true });

	const rows = new Map<string, string>();
	const cellOf = new Map<string, string>();
	for await (const line of jsonlLines(corpusFile)) {
		const row = JSON.parse(line) as CalibrationRow;
		const id = row.id ?? `${row.gameId}:${row.ply}`;
		rows.set(id, line);
		cellOf.set(id, cellFile(outDir, row.tc, row.bucket));
	}
	console.log(`corpus: ${rows.size} rows`);

	const policies = new Map<string, string>();
	for await (const line of jsonlLines(policiesFile)) {
		const id = headId(line);
		if (id !== null && rows.has(id)) policies.set(id, line);
	}
	console.log(`policies: ${policies.size} rows`);

	const writers = new Map<string, ReturnType<ReturnType<typeof Bun.file>["writer"]>>();
	let written = 0;
	let noPolicy = 0;
	for await (const line of jsonlLines(framesFile)) {
		const id = headId(line);
		if (id === null) continue;
		const row = rows.get(id);
		const file = cellOf.get(id);
		if (row === undefined || file === undefined) continue;
		const policy = policies.get(id);
		if (policy === undefined) {
			noPolicy++;
			continue;
		}
		const grid = (JSON.parse(policy) as { policies: unknown }).policies;
		let w = writers.get(file);
		if (!w) {
			w = Bun.file(file).writer();
			writers.set(file, w);
		}
		w.write(`{"row":${row},"frame":${line},"policies":${JSON.stringify(grid)}}\n`);
		written++;
		rows.delete(id);
	}
	for (const w of writers.values()) await w.end();
	console.log(
		`wrote ${written} rows into ${writers.size} cells under ${outDir}; ${noPolicy} without policies, ${rows.size} without frames`
	);
}

if (import.meta.main) await main();
