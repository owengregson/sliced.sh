// test/core/strength/helpers.ts — shared fixtures for the strength tests.
import { uciToSan } from "@core/chess/san";
import { createRng, type Rng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import type { SelectionContext, SelectionState } from "@core/strength/types";
import type { Eval, EvalLine } from "@typedefs/engine";

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Build an EvalLine; `san` is looked up from `fen` when omitted (cached per uci). */
const sanCache = new Map<string, string>();
export function line(
	fen: string,
	uci: string,
	score: Eval,
	multipv: number,
	pv: string[] = []
): EvalLine {
	const key = `${fen}|${uci}`;
	let san = sanCache.get(key);
	if (san === undefined) {
		san = uciToSan(fen, uci) ?? uci;
		sanCache.set(key, san);
	}
	return { multipv, score, depth: 20, pvUci: [uci, ...pv], pvSan: [san] };
}

export interface CtxOverrides extends Partial<Omit<SelectionContext, "rng" | "state">> {
	rng?: Rng;
	state?: SelectionState;
}

export function ctx(overrides: CtxOverrides = {}): SelectionContext {
	return {
		fen: START,
		targetElo: 1500,
		form: 0,
		ply: 0,
		phase: "opening",
		myClockMs: 180_000,
		oppClockMs: 180_000,
		selectionMode: "persona-sampling",
		blunderScale: 1,
		rng: createRng("strength"),
		state: createSelectionState(),
		...overrides,
	};
}

/** Uniform prior of 1.0 over the given lines. */
export function flatPrior(lines: readonly EvalLine[]): Map<string, number> {
	return new Map(lines.map((l) => [l.pvUci[0] ?? "", 1]));
}
