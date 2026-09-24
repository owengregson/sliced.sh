/** §7.2 step 9: turn the picked candidate into a `ChosenMove` and advance the per-game state. */

import { parseUci, uciToSan } from "@core/chess/san";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { fmt } from "../format";
import { moveQuality } from "../quality";
import type { SelectionContext } from "../types";
import type { Candidate } from "./candidate";
import { advanceSelectionState } from "./state";

/** §7.2 step 9: build the `ChosenMove` and advance the per-game state. */
export function finish(
	pick: Candidate,
	source: ChosenMove["source"],
	reference: readonly EvalLine[],
	ctx: SelectionContext,
	rationale: string[]
): ChosenMove {
	const parts = parseUci(pick.uci);
	if (!parts) throw new RangeError(`selectMove: invalid uci "${pick.uci}"`);
	advanceSelectionState(ctx.state, pick, source);
	if (pick.terms.length > 0)
		rationale.push(`prior: ${pick.terms.map((t) => `${t.rule} ×${fmt(t.factor)}`).join(", ")}`);
	const san = pick.line.pvSan[0] ?? uciToSan(ctx.fen, pick.uci) ?? pick.uci;
	const measured = moveQuality(reference, pick.line);
	if (source === "mate") {
		delete measured.cpLoss;
		measured.quality.eligible = false;
		measured.quality.reason = "mate";
	}
	const chosen: ChosenMove = {
		uci: pick.uci,
		san,
		from: parts.from,
		to: parts.to,
		source,
		rankInLines: pick.rank,
		...measured,
		rationale,
	};
	if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
	return chosen;
}
