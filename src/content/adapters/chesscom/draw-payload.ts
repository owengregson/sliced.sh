/** The chess.com wire shapes of the recommendation mark's draw and clear. */

import type { ArrowMark, SquareMark } from "../base/markings";
import type { DrawOptions } from "../contract";

/**
 * The overlay branch of the bridge draws from screen coordinates, so it needs the board's
 * orientation; native markings name squares and do not. Nothing sent it before, so an overlay
 * mark was mirrored for the whole of every game played as black — harmless while the overlay
 * was only the no-`game.markings` fallback, not harmless now that `forceOverlay` routes the
 * mark of the move being played through it. `isFlipped()` already means "black at the bottom",
 * which is what the overlay means by `black`.
 */
export function drawPayloadOf(
	highlights: SquareMark[],
	arrows: ArrowMark[],
	options: DrawOptions,
	flipped: boolean
): unknown {
	return {
		arrows,
		highlights,
		orientation: flipped ? "black" : "white",
		...(options.forceOverlay === true ? { forceOverlay: true } : {}),
	};
}

/**
 * Which markings to remove. The page side reads `(q && q.keys) || keys` — its own record of
 * everything it drew — so an **empty** array is a truthy no-op that clears nothing. The key is
 * therefore omitted unless we actually have keys to name, which makes a clear with no recorded
 * keys mean "everything of ours" rather than "nothing".
 */
export function clearPayloadOf(keys: readonly string[]): unknown {
	return keys.length > 0 ? { keys: [...keys] } : {};
}
