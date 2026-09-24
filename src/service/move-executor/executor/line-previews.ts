/**
 * The game's line-preview allowance (`LINE_PREVIEW`): whether a move may be given a preview and,
 * when the model draws one, the plan. Decided from its own stream so the motor's per-move sampling
 * is untouched by the choice, on the plan the hand will actually run (a retry's instant plan never
 * draws), never on a premove, never twice for one move, and at most `maxPerGame` times a game.
 */

import { LINE_PREVIEW } from "@core/motor/constants";
import { type LinePreviewInput, planLinePreview } from "@core/motor/line-preview";
import type { LinePreviewPlan } from "@core/motor/types";
import { createRng } from "@core/rng";

export class LinePreviewAllowance {
	/**
	 * Line previews this game (`LINE_PREVIEW.maxPerGame`) and the moves (`fen:uci`) that already
	 * got one — a replacement or a re-dispatch of the same move never previews twice. Counted when
	 * planned: a preview the hand cut short still spent the game's allowance.
	 */
	private readonly previews = { count: 0, moves: new Set<string>() };

	/** Moves of this game that were given a line preview. */
	count(): number {
		return this.previews.count;
	}

	/** The preview for this move, when the allowance and the model both grant one (and it is spent). */
	plan(input: LinePreviewInput, rngSeed: string): LinePreviewPlan | null {
		const lineKey = `${input.fen}:${input.chosenUci}`;
		if (
			input.mode === "off" ||
			this.previews.moves.has(lineKey) ||
			this.previews.count >= LINE_PREVIEW.maxPerGame
		)
			return null;
		const preview = planLinePreview(input, createRng(rngSeed));
		if (!preview) return null;
		this.previews.moves.add(lineKey);
		this.previews.count += 1;
		return preview;
	}
}
