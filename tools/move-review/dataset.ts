/**
 * tools/move-review/dataset.ts — the benchmark dataset a run reads (`--dataset <file>`, else
 * Chessigma's at the repository root) and the games replayed out of it.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { Chess, type Move } from "chess.js";
import { ROOT } from "../lib/paths";
import { type BenchmarkGame, DEFAULT_DATASET, START_FEN } from "./evidence";

export interface Dataset {
	games: BenchmarkGame[];
	/** SHA-256 of the file's text — every evidence frame pins it. */
	sha256: string;
}

export async function loadDataset(file: string | undefined): Promise<Dataset> {
	const text = await Bun.file(file ?? path.join(ROOT, DEFAULT_DATASET)).text();
	return {
		games: JSON.parse(text) as BenchmarkGame[],
		sha256: createHash("sha256").update(text).digest("hex"),
	};
}

export interface ReplayedGame {
	history: Move[];
	/** The position before the first move. */
	root: string;
	/** Every move as UCI (`lan`), in order. */
	moves: string[];
}

export function replayGame(entry: BenchmarkGame): ReplayedGame {
	const replay = new Chess();
	replay.loadPgn(entry.pgn);
	const history = replay.history({ verbose: true });
	return { history, root: history[0]?.before ?? START_FEN, moves: history.map((m) => m.lan) };
}
