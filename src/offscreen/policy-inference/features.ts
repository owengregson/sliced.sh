// src/offscreen/policy-inference/features.ts
/**
 * The Maia-3 input contract: what a well-formed query looks like, the FEN history the encoder
 * sees, and the float32 feeds — `tokens [1,64,96]`, `self_elo [1]`, `oppo_elo [1]` — a query
 * becomes.
 */

import { MAIA_INPUT } from "@core/constants/maia";
import { encodeMaiaInputs, type MaiaEncoded } from "@core/policy/maia-encoder";
import type { PolicyInferenceInputs } from "@core/policy/types";
import { isMaiaSize } from "../maia-store";
import type { OrtRuntime, OrtTensor } from "../ort-loader";

const TOKENS_LENGTH = MAIA_INPUT.squares * MAIA_INPUT.tokenDim;

/** Why `inputs` cannot be fed to the model, or `undefined` when they can. */
export function inputsProblem(inputs: PolicyInferenceInputs): string | undefined {
	if (!inputs || typeof inputs !== "object") return "missing inputs";
	if (!isMaiaSize(inputs.size)) return "size";
	if (typeof inputs.fen !== "string" || inputs.fen.length === 0) return "fen";
	if (!Array.isArray(inputs.historyFens) || !inputs.historyFens.every((f) => typeof f === "string"))
		return "historyFens";
	for (const key of ["selfElo", "oppoElo"] as const) {
		const v = inputs[key];
		if (typeof v !== "number" || !Number.isFinite(v)) return key;
	}
	return undefined;
}

/**
 * The history the encoder sees: the last `MAIA_INPUT.history` FENs ending in `fen` — appended
 * when the caller's list does not already end there (an empty list is just `[fen]`).
 */
export function historyForQuery(
	inputs: Pick<PolicyInferenceInputs, "fen" | "historyFens">
): string[] {
	const fens = [...inputs.historyFens];
	if (fens[fens.length - 1] !== inputs.fen) fens.push(inputs.fen);
	return fens.slice(-MAIA_INPUT.history);
}

/** The encoder's features for `historyFens`, checked against the model's input size. */
export function encode(historyFens: readonly string[]): MaiaEncoded {
	const encoded = encodeMaiaInputs(historyFens);
	if (encoded.tokens.length !== TOKENS_LENGTH)
		throw new Error(`encoder produced ${encoded.tokens.length} features, expected ${TOKENS_LENGTH}`);
	return encoded;
}

export function feedsFor(
	rt: OrtRuntime,
	encoded: MaiaEncoded,
	selfElo: number,
	oppoElo: number
): Record<string, OrtTensor> {
	return {
		[MAIA_INPUT.inputs.tokens]: rt.tensor("float32", encoded.tokens, [
			1,
			MAIA_INPUT.squares,
			MAIA_INPUT.tokenDim,
		]),
		[MAIA_INPUT.inputs.selfElo]: rt.tensor("float32", Float32Array.of(selfElo), [1]),
		[MAIA_INPUT.inputs.oppoElo]: rt.tensor("float32", Float32Array.of(oppoElo), [1]),
	};
}
