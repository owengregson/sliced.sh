/**
 * tools/move-review/score/frames.ts — the evidence a scoring run reads: every position frame of
 * the `--frames` files, each checked against the dataset and the installed engine.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { ENGINE_DIR, ENGINE_FILES } from "@core/constants/engine-files";
import type { ReviewFrame } from "@core/engine/move-quality";
import { ROOT } from "../../lib/paths";
import { assertFrameProvenance, type EvidenceFrame, readFrames } from "../evidence";

export interface FrameSet {
	/** By `game:index`; a later file wins where two hold the same position. */
	frames: Map<string, EvidenceFrame>;
	/** Every distinct provenance seen, by its JSON. */
	provenance: Map<string, NonNullable<EvidenceFrame["provenance"]>>;
}

/** SHA-256 of the installed full engine's wasm — what fresh evidence must have run. */
export async function installedWasmSha256(): Promise<string> {
	return createHash("sha256")
		.update(
			new Uint8Array(await Bun.file(path.join(ROOT, ENGINE_DIR, ENGINE_FILES.full.wasm)).arrayBuffer())
		)
		.digest("hex");
}

export async function loadFrameSet(
	files: readonly string[],
	datasetSha256: string,
	wasmSha256: string,
	allowLegacy: boolean
): Promise<FrameSet> {
	const frames = new Map<string, EvidenceFrame>();
	const provenance = new Map<string, NonNullable<EvidenceFrame["provenance"]>>();
	for (const file of files)
		for (const frame of await readFrames(file)) {
			// Restricted acceptance probes are not position evaluations and never replace them.
			if (frame.accept !== undefined) continue;
			const source = frame.provenance;
			assertFrameProvenance(frame, datasetSha256, wasmSha256, allowLegacy);
			if (source) provenance.set(JSON.stringify(source), source);
			frames.set(`${frame.game}:${frame.index}`, frame);
		}
	return { frames, provenance };
}

/** The classifier's view of the frame before move `index` of `game`. */
export function reviewFrameOf(set: FrameSet, game: number, index: number): ReviewFrame | undefined {
	const frame = set.frames.get(`${game}:${index}`);
	return frame ? { lines: frame.lines, depth: frame.depth, complete: frame.complete } : undefined;
}
