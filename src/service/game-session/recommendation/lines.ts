/** Engine-line helpers shared by the pipeline's stages and the max-strength deep search. */

import type { EvalLine } from "@typedefs/engine";

/** Lines whose first PV move is usable. */
export function usableLines(lines: readonly EvalLine[]): EvalLine[] {
	return lines.filter((l) => l.pvUci[0] !== undefined && l.pvUci[0] !== "");
}

/**
 * Append unique extra-search candidates without changing the main frame's order.
 * The main best line remains the evaluation and loss reference; a shallower extra
 * search must not replace it with an optimistic score. The selector ranks the merged pool.
 */
export function mergeLines(main: readonly EvalLine[], extra: readonly EvalLine[]): EvalLine[] {
	const seen = new Set(main.map((line) => line.pvUci[0]));
	const added = extra.filter((line) => {
		const uci = line.pvUci[0];
		if (uci === undefined || uci === "" || seen.has(uci)) return false;
		seen.add(uci);
		return true;
	});
	if (added.length === 0) return [...main];
	return [...main, ...added].map((line, i) => ({ ...line, multipv: i + 1 }));
}
