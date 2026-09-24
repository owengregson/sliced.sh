// src/offscreen/timing-inference/features.ts
/**
 * The timing head's input contract: what a well-formed query looks like, the warm-up query, and
 * the tensors a query becomes — the SW's token ids as int32 `[1, 90]`, the rating (clamped to
 * the band) and the log clocks standardised with the scalers of the band that runs.
 */

import { CHESS_START_FEN } from "@core/constants/chess";
import type { EnginePortCommand } from "@core/constants/messages";
import { type BandScalers, bandCentre, standardiseInputs } from "@core/timing/chessmimic-scalers";
import {
	INPUT_VOCAB_SIZE,
	MOVE_VOCABULARY,
	PAD_TOKEN,
	tokenizeFen,
} from "@core/timing/chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { OrtRuntime, OrtTensor } from "../ort-loader";

export type TimingInputs = Extract<EnginePortCommand, { kind: "timing" }>["inputs"];

const CM = TIMING_CONSTANTS.chessmimic;
const UNTIMED = TIMING_CONSTANTS.untimedVirtual;
const INPUT_NAMES = {
	ids: "input_ids",
	rating: "scaled_rating",
	clocks: "clock_features",
} as const;

function validTokens(tokens: unknown, length: number, vocab: number): tokens is number[] {
	return (
		Array.isArray(tokens) &&
		tokens.length === length &&
		tokens.every((t) => Number.isInteger(t) && t >= 0 && t < vocab)
	);
}

/** Why `inputs` cannot be fed to the model, or `undefined` when it can. */
export function inputsProblem(inputs: TimingInputs): string | undefined {
	if (!inputs || typeof inputs !== "object") return "missing inputs";
	if (typeof inputs.band !== "string") return "band";
	if (!validTokens(inputs.moveTokens, CM.recentMoves, MOVE_VOCABULARY.length)) return "moveTokens";
	if (!validTokens(inputs.fenTokens, CM.fenTokens, INPUT_VOCAB_SIZE)) return "fenTokens";
	for (const key of ["rating", "playerClockS", "opponentClockS", "incrementS"] as const) {
		const v = inputs[key];
		if (typeof v !== "number" || !Number.isFinite(v)) return key;
	}
	if (inputs.playerClockS < 0 || inputs.opponentClockS < 0 || inputs.incrementS < 0)
		return "negative clock";
	return undefined;
}

/** The warm-up query: the start position, no history, the band's centre, untimed clocks. */
export function warmInputs(band: string): TimingInputs {
	return {
		band,
		moveTokens: new Array<number>(CM.recentMoves).fill(PAD_TOKEN),
		fenTokens: tokenizeFen(CHESS_START_FEN),
		rating: bandCentre(band),
		playerClockS: UNTIMED.clockS,
		opponentClockS: UNTIMED.clockS,
		incrementS: UNTIMED.incS,
	};
}

/** The session feeds for `inputs` answered by `band` (whose scalers standardise them). */
export function feedsFor(
	rt: OrtRuntime,
	scalers: BandScalers | undefined,
	band: string,
	inputs: TimingInputs
): Record<string, OrtTensor> {
	const std = standardiseInputs({ ...inputs, band }, scalers);
	const ids = Int32Array.from([...inputs.moveTokens, ...inputs.fenTokens]);
	return {
		[INPUT_NAMES.ids]: rt.tensor("int32", ids, [1, ids.length]),
		[INPUT_NAMES.rating]: rt.tensor("float32", Float32Array.of(std.scaledRating), [1]),
		[INPUT_NAMES.clocks]: rt.tensor("float32", Float32Array.from(std.clockFeatures), [1, 3]),
	};
}
