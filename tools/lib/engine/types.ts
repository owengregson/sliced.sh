/**
 * tools/lib/engine/types.ts — the search contract every tool-side engine runner answers: one
 * `SearchSpec` in, one `SearchFrame` (a single MultiPV cycle) out, one search at a time.
 */

import type { EngineVariant, EvalLine } from "@typedefs/engine";

export interface SearchSpec {
	fen: string;
	movetimeMs: number;
	/** `go depth` cap; omitted = movetime alone. */
	depth?: number;
	multiPv: number;
	/** `go searchmoves …` — the frame then covers exactly these roots. */
	searchmoves?: readonly string[];
	/** `UCI_LimitStrength true` + `UCI_Elo`; omitted = full strength (the referee). */
	uciElo?: number;
	/** UCI moves applied after `fen` (`position fen … moves …`), so repetitions are seen. */
	moves?: readonly string[];
}

export interface SearchFrame {
	/** Sorted by `compareLines`, `multipv` renumbered 1…K, `pvSan` filled from `fen`. */
	lines: EvalLine[];
	bestmove: string | null;
	/** Depth of the cycle the lines come from. */
	depth: number;
	/** Whether every requested root was reported at `depth`. */
	complete: boolean;
	elapsedMs: number;
}

export interface RefereeEngine {
	search(spec: SearchSpec): Promise<SearchFrame>;
	/** `ucinewgame` once, queued behind any search in flight (a fresh transposition table). */
	newGame(): void;
	dispose(): void;
}

export interface RefereeOptions {
	/**
	 * `smallnet` (default) runs the vendored relaxed-SIMD program as before. `full` runs the
	 * package's plain-SIMD `sf_19` build — Bun's JavaScriptCore rejects relaxed SIMD — with the
	 * same Stockfish 19 sources and the packaged full network (`tools/move-review`).
	 */
	variant?: EngineVariant;
	threads?: number;
	hashMb?: number;
	/** Per-search wall-clock guard on top of the movetime (default 20 s). */
	timeoutMs?: number;
	/**
	 * `ucinewgame` before every search (default `true`, the fixtures' rule). `false` keeps the
	 * transposition table across searches, as the extension's review engine does within a game.
	 */
	newGameEachSearch?: boolean;
}

/** What the review worker proves about the engine it booted (pinned in every evidence frame). */
export interface ReviewEngineProvenance {
	version: string;
	module: string;
	networks: Record<string, string>;
	variant: "full";
	limitedStrength: false;
	wasmSha256: string;
	runtime: string;
	threads: number;
	hashMb: number;
}
