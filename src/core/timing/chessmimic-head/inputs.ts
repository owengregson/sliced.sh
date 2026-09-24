/**
 * The model inputs (`chessmimic-tokeniser`: FEN tokens, last-12 move window; raw rating and
 * clocks, the virtual 300 s clock for clockless games) for one position.
 *
 * The move window follows upstream's training contract when the timed move is known: the FEN is
 * the position *before* the move and the window's last token is the move itself
 * (`clock_game_parser.cpp`, "moves_including_current"). Without a move the window is the
 * history alone — the fallback row, which the fine-tuned top band is also trained on
 * (docs/models.md, "Fine-tuned 2200–3500 band").
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

/**
 * Build the model inputs from a `TimingContext`; clockless games get the fixed virtual clock.
 * `move` is the move being timed (`ctx.chosenMove` for the planned row, a candidate while the
 * search runs); empty or absent gives the history-only window.
 */
export function buildInputs(ctx: TimingContext, move?: string): ChessMimicInputs {
	const untimed = tcClass(ctx.baseSec, ctx.incSec) === "untimed";
	const moveTokens = encodeRecentMoves(move ? [...ctx.moves, move] : ctx.moves);
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
