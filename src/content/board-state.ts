/**
 * Colour-aware board reads for the executor's guards (Task 30, §9.3):
 *
 *   - `occupancyOf` turns the adapter's DOM placement into `own` / `enemy` /
 *     `empty` **relative to the side the hand plays**, which is what makes a
 *     capture distinguishable from a move that already landed;
 *   - `waitForPromotionRect` polls the adapter for the promotion picker after
 *     the drop and gives up at the executor's budget (the picker never appears
 *     under an auto-queen preference).
 *
 * Read-only: no page storage, no synthetic events, nothing written to the DOM
 * (§13.3).
 */

import type { Rect, SiteAdapter } from "@content/adapters/adapter";
import { pieceAt, placementOf } from "@content/adapters/dom-fen";
import { TIMINGS } from "@core/constants/timings";
import type { Occupancy } from "@core/motor/types";
import type { Color, PromoPiece, Square } from "@typedefs/game";

/** The adapter surface these helpers need (a `SiteAdapter` satisfies it). */
export type BoardStateAdapter = Pick<
	SiteAdapter,
	"getPlacement" | "getFen" | "getMyColor" | "getPromotionTargetRect"
>;

/** The freshest placement the adapter can give: the DOM read, else the FEN it published. */
export function currentPlacement(adapter: BoardStateAdapter): string | null {
	const dom = adapter.getPlacement();
	if (dom !== null && dom !== "") return dom;
	const fen = adapter.getFen();
	return fen === null ? null : placementOf(fen);
}

/** `own` / `enemy` / `empty` for `square` from `me`'s point of view; `undefined` when unreadable. */
export function occupancyAt(placement: string, square: Square, me: Color): Occupancy | undefined {
	const piece = pieceAt(placement, square);
	if (piece === null) return "empty";
	if (piece === "") return "empty";
	const colour: Color = piece === piece.toUpperCase() ? "w" : "b";
	return colour === me ? "own" : "enemy";
}

/**
 * Occupancy of exactly `squares`. A square the adapter cannot classify — no
 * placement, no known colour — is **left out**, and the executor then
 * dispatches nothing rather than guessing (`verification-unavailable`).
 */
export function occupancyOf(
	adapter: BoardStateAdapter,
	squares: readonly Square[]
): Partial<Record<Square, Occupancy>> {
	const me = adapter.getMyColor();
	const placement = currentPlacement(adapter);
	if (me === null || placement === null) return {};
	const out: Partial<Record<Square, Occupancy>> = {};
	for (const square of squares) {
		const value = occupancyAt(placement, square, me);
		if (value !== undefined) out[square] = value;
	}
	return out;
}

export interface PromotionWaitOptions {
	/** Total budget; the executor sends its own (`EXECUTOR.promotionPickerTimeoutMs`). */
	timeoutMs: number;
	/** Poll spacing (default `TIMINGS.contentReadyPollMs / 10` ≈ one frame). */
	pollMs?: number;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
}

/** One poll step, in ms, when the caller does not choose (≈ a frame). */
export const PROMOTION_POLL_MS = Math.max(1, Math.round(TIMINGS.contentReadyPollMs / 30));

/**
 * The promotion target rect for `piece` on `dest` once the picker is up, or
 * `null` when it has not appeared inside `timeoutMs` (auto-queen, or the
 * adapter cannot read it).
 */
export function waitForPromotionRect(
	adapter: BoardStateAdapter,
	dest: Square,
	piece: PromoPiece,
	options: PromotionWaitOptions
): Promise<Rect | null> {
	const now = options.now ?? (() => Date.now());
	const later = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const pollMs = options.pollMs ?? PROMOTION_POLL_MS;
	const deadline = now() + options.timeoutMs;
	return new Promise<Rect | null>((resolve) => {
		const attempt = (): void => {
			let rect: Rect | null = null;
			try {
				rect = adapter.getPromotionTargetRect(dest, piece);
			} catch {
				rect = null;
			}
			if (rect && rect.width > 0) {
				resolve(rect);
				return;
			}
			if (now() >= deadline) {
				resolve(null);
				return;
			}
			later(attempt, pollMs);
		};
		attempt();
	});
}
