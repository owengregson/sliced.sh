/**
 * tools/calibration/rating-eval/extract.ts — every cell's human moves the referee scored, judged and
 * classed once, into `moves.jsonl`.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { jsonlLines } from "../../lib/jsonl";
import { CELLS_DIR } from "../cells";
import { moveClass } from "../rating-model";
import { type CellItem, judgeFor, positionFacts } from "../sim";
import { type HumanMove, MOVES_FILE } from "./moves";

export async function extract(): Promise<void> {
	const writer = Bun.file(MOVES_FILE).writer();
	let n = 0;
	for (const f of readdirSync(CELLS_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()) {
		for await (const line of jsonlLines(path.join(CELLS_DIR, f))) {
			const it = JSON.parse(line) as CellItem;
			const judge = judgeFor(it.frame);
			Object.assign(judge.shape, positionFacts(it.row.fen));
			const human = judge.outcome(it.row.humanMove);
			if (human === null) continue;
			const row = it.row;
			const move: HumanMove = {
				tc: row.tc,
				bucket: row.bucket,
				split: row.split ?? "fit",
				rating: row.selfElo,
				game: `${row.gameId ?? row.id}:${row.color ?? ""}`,
				clockFrac: (row.baseMs ?? 0) > 0 ? row.clockMs / (row.baseMs ?? 1) : 1,
				shape: judge.shape,
				y: moveClass(human),
			};
			writer.write(`${JSON.stringify(move)}\n`);
			n++;
		}
		console.log(`${f}: ${n} moves so far`);
	}
	await writer.end();
	console.log(`wrote ${n} moves → ${MOVES_FILE}`);
}
