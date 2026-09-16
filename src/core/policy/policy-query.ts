import { matchingHistory, type PositionHistory, positionKey } from "@core/chess/history";
import type { SelectionContext } from "@core/strength/types";
import type { PolicyInferenceInputs } from "./types";

/**
 * All inputs that determine a reusable answer, including the game's repetition history. Maia has
 * one query mode since the upper prior band was removed (2026-09-15), so no mode is keyed.
 */
export function policyQueryIdentity(query: {
	inputs: PolicyInferenceInputs;
	selectionMode: SelectionContext["selectionMode"];
	history?: PositionHistory | undefined;
}): string {
	const { inputs, selectionMode } = query;
	const history = matchingHistory(query.history, inputs.fen) ?? { fen: inputs.fen, moves: [] };
	return JSON.stringify([
		selectionMode,
		inputs.size,
		inputs.selfElo,
		inputs.oppoElo,
		positionKey(inputs.fen),
		inputs.historyFens.map(positionKey),
		positionKey(history.fen),
		history.fen.trim().split(/\s+/)[4] ?? "0",
		history.moves,
	]);
}
