/**
 * tools/calibration/frames/store.ts — the frame cache on disk: the ids a frames JSONL already
 * holds, the grid policies of the rows to search, and the merge of the workers' part files into
 * `--out` (resumable: a torn last line is skipped, an id already present is never written twice).
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { headId, jsonlLines } from "../../lib/jsonl";
import type { FrameCacheRecord, GridPolicy, PolicyRecord } from "./schema";

/** Ids already written to a frames JSONL (tolerates a torn last line). */
export async function idsIn(file: string, into: Set<string>): Promise<void> {
	if (!existsSync(file)) return;
	for await (const line of jsonlLines(file)) {
		const id = headId(line);
		if (id !== null) into.add(id);
	}
}

export async function loadPolicies(
	file: string | undefined,
	want: Set<string>
): Promise<Map<string, GridPolicy[]>> {
	const out = new Map<string, GridPolicy[]>();
	if (file === undefined || !existsSync(file)) return out;
	for await (const line of jsonlLines(file)) {
		// Cheap pre-filter by a leading id; fall back to a full parse for other key orders.
		const id = headId(line);
		if (id !== null && !want.has(id)) continue;
		const rec = JSON.parse(line) as PolicyRecord;
		if (want.has(rec.id)) out.set(rec.id, rec.policies);
	}
	return out;
}

/** Append every part record whose id `out` lacks, then drop the parts directory. */
export async function mergeParts(out: string, partsDir: string): Promise<number> {
	if (!existsSync(partsDir)) return 0;
	const have = new Set<string>();
	await idsIn(out, have);
	let added = 0;
	for (const name of readdirSync(partsDir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const chunk: string[] = [];
		for await (const line of jsonlLines(path.join(partsDir, name))) {
			let rec: FrameCacheRecord;
			try {
				rec = JSON.parse(line) as FrameCacheRecord;
			} catch {
				continue; // a torn last line from an interrupted worker
			}
			if (have.has(rec.id)) continue;
			have.add(rec.id);
			chunk.push(line);
			added++;
		}
		if (chunk.length > 0) await appendFile(out, `${chunk.join("\n")}\n`);
	}
	rmSync(partsDir, { recursive: true, force: true });
	return added;
}
