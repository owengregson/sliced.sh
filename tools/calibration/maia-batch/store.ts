/**
 * tools/calibration/maia-batch/store.ts — the policies file: every probability and WDL value
 * rounded to 6 significant digits, moves under p = 1e-5 dropped, and the ids a (possibly torn)
 * file already holds.
 */

import { existsSync } from "node:fs";
import { readFile, truncate } from "node:fs/promises";
import type { MaiaGridResult } from "./types";

/** File rounding / pruning (CLI output only). */
const STORE_DIGITS = 6;
const STORE_MIN_P = 1e-5;

const round = (x: number): number => Number(x.toPrecision(STORE_DIGITS));

/** The stored form: 6 significant digits, moves under `STORE_MIN_P` dropped. */
export function compactResult(result: MaiaGridResult): MaiaGridResult {
	return {
		id: result.id,
		policies: result.policies.map((p) => ({
			selfElo: p.selfElo,
			moves: p.moves.filter(([, x]) => x >= STORE_MIN_P).map(([u, x]) => [u, round(x)]),
			wdl: [round(p.wdl[0]), round(p.wdl[1]), round(p.wdl[2])],
		})),
	};
}

/** Ids already in `out`; a torn (newline-less) tail is truncated so appends stay valid JSONL. */
export async function doneIds(out: string): Promise<Set<string>> {
	const ids = new Set<string>();
	if (!existsSync(out)) return ids;
	const text = await readFile(out, "utf8");
	const end = text.lastIndexOf("\n") + 1;
	if (end < text.length) await truncate(out, Buffer.byteLength(text.slice(0, end)));
	for (const line of text.slice(0, end).split("\n")) {
		if (!line) continue;
		const id = (JSON.parse(line) as { id?: unknown }).id;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}
