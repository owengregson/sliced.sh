/**
 * UCI client framework types (§6.4 / §6.5). `EvalLine`, `Eval` and
 * `EngineStatus` live in `@typedefs/engine`; everything else in the framework
 * is declared here so `uci-client`, `options` and `analysis-cache` share one
 * definition.
 */

import type { EngineStatus, EvalLine } from "@typedefs/engine";

/** Line-oriented UCI transport (a Worker in the offscreen document, a port in the SW). */
export interface EngineTransport {
	send(line: string): void;
	/** Returns unsubscribe. */
	onLine(cb: (line: string) => void): () => void;
	/** `state: "crashed"` drives the client's crash path. Returns unsubscribe. */
	onStatus(cb: (s: EngineStatus) => void): () => void;
	restart(): Promise<void>;
}

/** `go` arguments; `depth` + `movetimeMs` together mean "whichever comes first". */
export interface AnalysisLimit {
	depth?: number;
	movetimeMs?: number;
	nodes?: number;
	infinite?: true;
}

/** Queue priority: `move` > `ponder` > `panel` (default `move`). */
export type AnalysisPriority = "move" | "ponder" | "panel";

export interface AnalysisRequest {
	id: string;
	fen: string;
	/** UCI moves applied after `fen` (kept so the engine sees repetitions). */
	moves?: string[];
	multiPv: number;
	limit: AnalysisLimit;
	searchmoves?: string[];
	/** `UCI_Elo`; undefined = full strength. */
	elo?: number;
	priority?: AnalysisPriority;
	/**
	 * H4 (2026-09-13): the depth of the side frame the client captures as `atFeatureDepth` — the
	 * first complete MultiPV iteration at or past it. Absent = `LIMITS.featureDepth` (the timing
	 * model's `D_f`); Maia mode asks for `humanDepth(E)`. Part of the cache identity.
	 */
	featureDepth?: number;
	/**
	 * H10 (2026-09-13): a Maia-shaped own-move search — `searchmoves` is the full root set the
	 * pipeline chose (Maia's top-k plus the engine's known best), `multiPv` its size. Only such a
	 * restricted result is cached and answered from the cache, keyed on the sorted roots; any other
	 * `searchmoves` request keeps today's never-cached rule.
	 */
	shaped?: true;
}

export interface AnalysisUpdate {
	id: string;
	depth: number;
	seldepth?: number;
	/** Latest line per multipv index, sorted by multipv. */
	lines: EvalLine[];
	nodes: number;
	nps: number;
	timeMs: number;
	/** All multipv lines for `depth` arrived. */
	complete: boolean;
}

export type AnalysisStatus = "complete" | "superseded" | "failed";

export interface AnalysisResult {
	id: string;
	/** `null` on `bestmove (none)` or when the search never produced one. */
	bestmove: string | null;
	ponder?: string;
	final: AnalysisUpdate;
	engineElo?: number;
	status: AnalysisStatus;
	/**
	 * The complete iteration at the request's `featureDepth` (§6.5; default `FEATURE_DEPTH`), if
	 * one was reached: the first complete frame at or past that depth — re-captured while the
	 * frame at that same depth is re-emitted, never replaced by a deeper one (2026-09-13, H4).
	 */
	atFeatureDepth?: AnalysisUpdate;
	/** The request this result answers (the cache keys on it). */
	request: AnalysisRequest;
}

export interface AnalysisHandle {
	id: string;
	/** Single-slot mailbox: a slow consumer sees the newest update, never a backlog. */
	updates: AsyncIterable<AnalysisUpdate>;
	result: Promise<AnalysisResult>;
	/** Resolves once the search has ended (after `bestmove`, or immediately if queued). */
	stop(): Promise<void>;
}

export interface UciOptionSpec {
	type: "check" | "spin" | "combo" | "button" | "string";
	default?: string;
	min?: number;
	max?: number;
	vars?: string[];
}

/** Parsed from the `id` / `option` lines between `uci` and `uciok`. */
export interface EngineInfo {
	name: string;
	author: string;
	options: Record<string, UciOptionSpec>;
}

export type EngineOptionValue = number | boolean;

/** UCI options the extension sets (names are the exact wire names). */
export interface EngineOptions {
	Threads: number;
	Hash: number;
	MultiPV: number;
	UCI_ShowWDL: boolean;
	UCI_LimitStrength: boolean;
	UCI_Elo: number;
	"Skill Level"?: number;
	Ponder: boolean;
	"Move Overhead"?: number;
}

export type EngineState = "idle" | "initialising" | "searching" | "stopping" | "crashed";
