/**
 * tools/move-review/collect/resume.ts — appending to an evidence file that already holds frames.
 * A rerun skips the frames present, so shards run in parallel over disjoint `--games` ranges and
 * resume after an interruption — but only into a file of the same dataset, search settings and
 * engine, never a mix.
 */

import { appendFile } from "node:fs/promises";
import type { EvidenceFrame, EvidenceProvenance } from "../evidence";

/** A frame's identity in the file: `game:index`, or `game:index:capture` for an accept probe. */
export function frameKey(frame: Pick<EvidenceFrame, "game" | "index" | "accept">): string {
	return frame.accept === undefined
		? `${frame.game}:${frame.index}`
		: `${frame.game}:${frame.index}:${frame.accept}`;
}

export function assertSameSettings(
	existing: readonly EvidenceFrame[],
	datasetSha256: string,
	depth: number,
	movetimeMs: number
): void {
	if (
		existing.some(
			(frame) =>
				frame.provenance?.datasetSha256 !== datasetSha256 ||
				frame.provenance?.requestedDepth !== depth ||
				frame.provenance?.movetimeMs !== movetimeMs
		)
	)
		throw new Error(
			"Cannot resume evidence with unknown/different dataset or search settings; use a new --out"
		);
}

export function assertSameEngine(
	existing: readonly EvidenceFrame[],
	provenance: EvidenceProvenance
): void {
	if (existing.some((frame) => JSON.stringify(frame.provenance) !== JSON.stringify(provenance)))
		throw new Error(
			"Cannot resume evidence from a different engine/network/runtime; use a new --out"
		);
}

/** Repair only a interrupted final append, after validating every complete record above. */
export async function repairInterruptedAppend(out: string): Promise<void> {
	if (!(await Bun.file(out).exists())) return;
	const text = await Bun.file(out).text();
	if (text.length > 0 && !text.endsWith("\n")) {
		const tail = text.slice(text.lastIndexOf("\n") + 1);
		try {
			JSON.parse(tail);
			await appendFile(out, "\n");
		} catch {
			await Bun.write(out, text.slice(0, text.lastIndexOf("\n") + 1));
		}
	}
}
