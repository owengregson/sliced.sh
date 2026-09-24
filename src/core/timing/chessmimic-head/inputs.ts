/**
 * The model inputs (`chessmimic-tokeniser`: FEN tokens, last-12 move window; raw rating and
 * clocks, the virtual 300 s clock for clockless games) for one position.
 */
import type { TimingInferenceInputs } from "@core/constants/messages";
import type { ChessMimicBand } from "@core/constants/models";
import { encodeRecentMoves, tokenizeFen } from "../chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "../constants";
import { tcClass } from "../features";
import type { TimingContext } from "../types";
import { selectBand } from "./bands";

const CM = TIMING_CONSTANTS.chessmimic;
const UNTIMED = TIMING_CONSTANTS.untimedVirtual;

/** The `timing` port payload with the band narrowed to a registered one. */
export interface ChessMimicInputs extends TimingInferenceInputs {
	band: ChessMimicBand;
}

/** Build the model inputs from a `TimingContext`; clockless games get the fixed virtual clock. */
export function buildInputs(ctx: TimingContext): ChessMimicInputs {
	const untimed = tcClass(ctx.baseSec, ctx.incSec) === "untimed";
	const moveTokens = encodeRecentMoves(ctx.moves);
	const fenTokens = tokenizeFen(ctx.fen);
	const sequenceLength = moveTokens.length + 2 + fenTokens.length;
	if (sequenceLength !== CM.sequenceLength)
		throw new RangeError(
			`chessmimic inputs: ${sequenceLength} tokens, expected ${CM.sequenceLength}`
		);
	return {
		band: selectBand(ctx.targetElo),
		moveTokens,
		fenTokens,
		rating: ctx.targetElo,
		playerClockS: untimed ? UNTIMED.clockS : Math.max(0, ctx.myClockMs / 1000),
		opponentClockS: untimed ? UNTIMED.clockS : Math.max(0, ctx.oppClockMs / 1000),
		incrementS: untimed ? UNTIMED.incS : ctx.incSec,
	};
}
