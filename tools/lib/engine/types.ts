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
	/**
	 * Side captures of the same search, one per requested depth `d`: the **first complete MultiPV
	 * cycle at depth ≥ d**, refreshed only while that same depth is re-emitted — the rule
	 * `src/core/engine/uci-client.ts` applies to `atFeatureDepth` (the pipeline's human-depth
	 * frame). Omitted = no capture, and `SearchFrame.byDepth` is absent.
	 */
	captureDepths?: readonly number[];
	/**
	 * Build `lines` by `uci-client.ts`'s cycle rule instead of the fixtures' per-slot collection:
	 * the deepest complete strict cycle (`multipv` 1…K in order, one depth, exact non-increasing
	 * scores, unique legal roots), else the deepest / widest partial one — what the pipeline's
	 * `analysis.final` holds. The per-slot rule can mix a re-searched slot into an older cycle and
	 * report one root twice. Omitted = the per-slot rule (the fixtures'), unchanged.
	 */
	strictCycles?: boolean;
}

/** One `captureDepths` capture: the cycle's roots in the engine's own (score) order. */
export interface CapturedCycle {
	/** The depth the cycle was reported at (≥ the requested depth). */
	depth: number;
	lines: Array<{ uci: string; score: EvalLine["score"] }>;
}

/** One `info … multipv k` line as a runner holds it before building the frame's `EvalLine`s. */
export interface RawLine {
	multipv: number;
	depth: number;
	score: EvalLine["score"];
	pv: string[];
	wdl?: [number, number, number];
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
	/** Present when `SearchSpec.captureDepths` was: requested depth → capture (absent = never reached). */
	byDepth?: Record<number, CapturedCycle>;
}

export interface RefereeEngine {
	search(spec: SearchSpec): Promise<SearchFrame>;
	/** `ucinewgame` once, queued behind any search in flight (a fresh transposition table). */
	newGame(): void;
	dispose(): void;
}

export interface RefereeOptions {
	/**
	 * `smallnet` (default) or `full` (`tools/move-review`). Either runs the npm package's
	 * plain-SIMD build of the same Stockfish 19 sources — Bun's JavaScriptCore rejects the shipped
	 * relaxed-SIMD programs — with the vendored networks.
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
