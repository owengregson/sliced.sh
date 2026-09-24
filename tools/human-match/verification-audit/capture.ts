/**
 * tools/human-match/verification-audit/capture.ts — the immutable model and search inputs of each
 * position, captured once into the cache directory (79M Maia at the actual ratings, a shallow
 * frame at the human depth and a depth-12 reference frame from SF19 full).
 */

import path from "node:path";
import { humanDepth } from "@core/engine/depth-policy";
import type { PolicyResult } from "@core/policy/types";
import { createRefereeEngine } from "../../lib/engine/referee";
import type { SearchFrame } from "../../lib/engine/types";
import { createMaiaRunner } from "../../lib/maia";
import type { AuditPosition } from "./sample";

export interface CapturedRecord {
	position: AuditPosition;
	policy: PolicyResult;
	shallow: SearchFrame;
	deep: SearchFrame;
}

export const recordFile = (cache: string, position: AuditPosition): string =>
	path.join(cache, `${position.id}.json`);

/** Captures every position the cache does not hold yet; the engines start only when needed. */
export async function captureMissing(
	positions: readonly AuditPosition[],
	cache: string
): Promise<void> {
	const missing = [];
	for (const position of positions)
		if (!(await Bun.file(recordFile(cache, position)).exists())) missing.push(position);
	if (missing.length === 0) return;
	const maia = await createMaiaRunner(1);
	const engine = await createRefereeEngine({ variant: "full", threads: 2, hashMb: 64 });
	try {
		for (const [i, position] of missing.entries()) {
			const policy = await maia.query("79m", position.historyFens, position.selfElo, position.oppoElo);
			const shallow = await engine.search({
				fen: position.fen,
				multiPv: policy.moves.length,
				depth: humanDepth(position.selfElo),
				movetimeMs: 3000,
			});
			const deep = await engine.search({
				fen: position.fen,
				multiPv: policy.moves.length,
				depth: 12,
				movetimeMs: 1500,
			});
			if (!shallow.complete || !deep.complete) throw new Error(`${position.id}: incomplete frame`);
			await Bun.write(
				recordFile(cache, position),
				JSON.stringify({ position, policy, shallow, deep })
			);
			if ((i + 1) % 10 === 0) console.log(`captured ${i + 1}/${missing.length}`);
		}
	} finally {
		await maia.dispose();
		engine.dispose();
	}
}
