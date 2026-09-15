import { matchingHistory, type PositionHistory, positionKey } from "@core/chess/history";
import type { SelectionContext } from "@core/strength/types";
import type { PolicyInferenceInputs } from "./types";

export type PolicyQueryMode = "maia" | "prior";

/** All inputs that determine a reusable answer, including the game's repetition history. */
export function policyQueryIdentity(query: {
	inputs: PolicyInferenceInputs;
	mode: PolicyQueryMode;
	selectionMode: SelectionContext["selectionMode"];
	history?: PositionHistory | undefined;
}): string {
	const { inputs, mode, selectionMode } = query;
	const history = matchingHistory(query.history, inputs.fen) ?? { fen: inputs.fen, moves: [] };
	return JSON.stringify([
		mode,
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
