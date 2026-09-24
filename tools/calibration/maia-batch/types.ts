/**
 * tools/calibration/maia-batch/types.ts — the batch path's API: a grid request (one position, many
 * self-Elo ratings), its policies, the pool options, and one query of a batch.
 */

export interface MaiaGridRequest {
	id: string;
	/** Oldest → newest, the last the position to move in. */
	historyFens: string[];
	oppoElo: number;
	selfElos: number[];
}

export interface MaiaGridPolicy {
	selfElo: number;
	/** Board-frame UCI, descending by p, exactly as `decodeMaiaOutputs` returns. */
	moves: Array<[string, number]>;
	wdl: [number, number, number];
}

export interface MaiaGridResult {
	id: string;
	policies: MaiaGridPolicy[];
}

export interface MaiaGridOptions {
	/** CPU-EP worker processes (default 3). */
	workers?: number;
	/** onnxruntime intra-op threads per CPU worker (default 2). */
	threads?: number;
	/** CoreML-EP (GPU, static batch) worker processes alongside the CPU ones (default 1). */
	coremlWorkers?: number;
	/** Queries per batch file / session run (default 32; the CoreML graph is built for it). */
	batch?: number;
	python?: string;
	/** Called after every finished batch with the queries done so far in this call. */
	onProgress?: (doneQueries: number, totalQueries: number) => void;
}

/** One (request, grid slot) query as a batch file lists it. */
export interface Query {
	request: number;
	slot: number;
	selfElo: number;
}
