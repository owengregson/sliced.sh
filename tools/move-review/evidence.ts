/**
 * tools/move-review/evidence.ts — the shapes `collect.ts` writes and `score.ts` reads.
 */

import { ENGINE_FILES } from "@core/constants/engine-files";
import type { EvalLine } from "@typedefs/engine";
import type { ReviewEngineProvenance } from "../lib/engine/types";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** One entry of `chessigma-brilliant-benchmark.json`. `ply` is 1-based: move `ply - 1` (0-based). */
export interface BenchmarkGame {
	pgn: string;
	ply: number;
	/** Every brilliant ply, 1-based, when the dataset knows more than one (`pgn-labels.ts`). */
	brilliants?: number[];
	/** chess.com's own marks by 1-based ply (`Brilliant`, `GreatFind`, `Blunder`, …). */
	labels?: Record<string, string>;
}

/** The dataset a tool reads: `--dataset <file>`, else Chessigma's at the repository root. */
export const DEFAULT_DATASET = "chessigma-brilliant-benchmark.json";

/** 1-based brilliant plies of a game. */
export function brilliantPlies(game: BenchmarkGame): number[] {
	return game.brilliants ?? (game.ply > 0 ? [game.ply] : []);
}

/** One review search: the frame for the position before move `index` (0-based) of game `game`. */
export interface EvidenceFrame {
	/** Required for newly collected evidence; legacy files must be explicitly opted into. */
	provenance?: EvidenceProvenance;
	game: number;
	index: number;
	fen: string;
	depth: number;
	complete: boolean;
	elapsedMs: number;
	lines: EvalLine[];
	/**
	 * `accept` mode: the frame is the position *after* move `index`, searched with `searchmoves`
	 * restricted to this capture — the opponent taking the offered piece.
	 */
	accept?: string;
}

/** The review engine's own provenance, plus the dataset and search settings of the collection. */
export interface EvidenceProvenance extends ReviewEngineProvenance {
	datasetSha256?: string;
	requestedDepth?: number;
	movetimeMs?: number;
	multiPv?: number;
}

/** Restricted probes are handled separately; verify an unrestricted frame's source. */
export function assertFrameProvenance(
	frame: EvidenceFrame,
	datasetSha256: string,
	wasmSha256: string,
	allowLegacy = false
): void {
	const source = frame.provenance;
	if (!source) {
		if (allowLegacy) return;
		throw new Error("Missing provenance; recollect or explicitly use --allow-legacy");
	}
	if (
		source.datasetSha256 !== datasetSha256 ||
		source.wasmSha256 !== wasmSha256 ||
		source.variant !== "full" ||
		source.limitedStrength !== false ||
		source.module !== ENGINE_FILES.full.js ||
		Object.keys(source.networks).length !== ENGINE_FILES.full.nnue.length ||
		!ENGINE_FILES.full.nnue.every((name) => source.networks[name]?.startsWith(name.slice(3, 15)))
	)
		throw new Error("Evidence is not from this dataset and the installed full review engine");
}

/** Every frame in a JSONL file (missing file = none); a truncated last line is ignored. */
export async function readFrames(file: string): Promise<EvidenceFrame[]> {
	const handle = Bun.file(file);
	if (!(await handle.exists())) return [];
	const frames: EvidenceFrame[] = [];
	const rows = (await handle.text()).split("\n");
	for (const [index, row] of rows.entries()) {
		if (!row.trim()) continue;
		try {
			frames.push(JSON.parse(row) as EvidenceFrame);
		} catch {
			if (index !== rows.length - 1) throw new Error(`Corrupt evidence at ${file}:${index + 1}`);
			// Only an interrupted final append is ignored, never an interior corrupt row.
		}
	}
	return frames;
}
