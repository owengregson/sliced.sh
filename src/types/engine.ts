/**
 * Engine-facing types shared across contexts (§6.3 `EngineStatus`, §6.4
 * `EvalLine`). Task 3 / Task 11 extend this file with the rest of the UCI
 * framework types.
 */

export type EngineVariant = "smallnet" | "full";

/** Reported by the offscreen engine host over `PORT_NAMES.engine` (§6.3). */
export interface EngineStatus {
	state: "booting" | "loading-nnue" | "ready" | "searching" | "crashed";
	variant: EngineVariant;
	threads: number;
	nnue: string[];
	nps?: number;
	version: string;
	/** Set on `crashed` (and on a failed `loadNnue`) with the engine's or loader's message. */
	error?: string;
}

/** A UCI score: centipawns or mate-in-N (sign from the side to move). */
export interface Eval {
	cp?: number;
	mate?: number;
}

/** One MultiPV line at a given depth (§4.3 / §6.4). */
export interface EvalLine {
	multipv: number;
	score: Eval;
	depth: number;
	pvUci: string[];
	pvSan: string[];
	seldepth?: number;
	/** Per-mille win/draw/loss from the side to move (`UCI_ShowWDL`). */
	wdl?: [number, number, number];
	/** Set when the line is a fail-high/low interim report (only kept for multipv > 1). */
	bound?: "lower" | "upper";
}
