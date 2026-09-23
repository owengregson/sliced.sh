/** Where a preview's selection is cleared: a square whose click can never fire a move. */
import { distance, squareOf } from "@core/chess/squares";
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { PREVIEW } from "../constants";
import type { Occupancy } from "../types";

const ALL_SQUARES: Square[] = [];
for (let r = 0; r < 8; r++)
	for (let f = 0; f < 8; f++) {
		const sq = squareOf(f, r);
		if (sq) ALL_SQUARES.push(sq);
	}

export interface DeselectChoice {
	square: Square;
	resolve: "deselect" | "switch-to-idle";
	occupancy?: Occupancy;
}

/**
 * A square whose click resolves the selection without ever firing a move: not
 * a legal destination of the previewed piece, not the piece itself, not the
 * committed squares. With `occupancy` the tiers are empty → enemy (both clear
 * the selection) → own piece with no legal moves (labelled `switch-to-idle`:
 * a third selection that the committed press switches away from). Without
 * `occupancy` a square with no legal moves of its own is used and labelled
 * `deselect`. Nearby squares are preferred.
 */
export function deselectSquare(
	piece: Square,
	dests: readonly Square[],
	committed: { from: Square; to: Square },
	legalDestinations: (sq: Square) => Square[],
	occupancy: ((sq: Square) => Occupancy) | undefined,
	rng: Rng
): DeselectChoice | null {
	const banned = new Set<Square>([piece, committed.from, committed.to, ...dests]);
	const tiers: Record<Occupancy, Square[]> = { empty: [], enemy: [], own: [] };
	for (const sq of ALL_SQUARES) {
		if (banned.has(sq)) continue;
		if (occupancy) {
			const occ = occupancy(sq);
			if (occ === "own" && legalDestinations(sq).length > 0) continue;
			tiers[occ].push(sq);
		} else if (legalDestinations(sq).length === 0) tiers.empty.push(sq);
	}
	const pick = (pool: Square[]): Square =>
		rng.weighted(
			pool,
			pool.map((sq) => {
				const d = distance(piece, sq).chebyshev;
				return d <= PREVIEW.deselectMaxDistance ? 1 / (1 + d) : 0.05 / (1 + d);
			})
		);
	if (tiers.empty.length > 0) {
		const square = pick(tiers.empty);
		return occupancy
			? { square, resolve: "deselect", occupancy: "empty" }
			: { square, resolve: "deselect" };
	}
	if (tiers.enemy.length > 0)
		return { square: pick(tiers.enemy), resolve: "deselect", occupancy: "enemy" };
	if (tiers.own.length > 0)
		return { square: pick(tiers.own), resolve: "switch-to-idle", occupancy: "own" };
	return null;
}
