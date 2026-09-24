import type { Rng } from "@core/rng";
import { EXPLORATION, SAMPLING } from "../constants";
import { pointInBand } from "../sampling";
import type { BoardGeometry, Pt, RestStyle } from "../types";

/**
 * A rest position (§9.4): on/near the dropped piece (`anchor`), near the
 * clock / move list, or just off the board; `mixed` draws by the §4 weights.
 */
export function restPoint(
	geometry: BoardGeometry,
	style: RestStyle,
	anchor: Pt | null,
	rng: Rng
): Pt {
	const w = SAMPLING.startWeights;
	const chosen =
		style === "mixed"
			? rng.weighted(["piece", "clock", "offboard"] as const, [w.ownHalf, w.clock, w.offBoard])
			: style;
	let p: Pt;
	if (chosen === "piece") {
		if (anchor) {
			const lim = EXPLORATION.restPieceMaxPx;
			const dx = Math.max(-lim, Math.min(lim, rng.normal(0, EXPLORATION.restPieceSigmaPx)));
			const dy = Math.max(-lim, Math.min(lim, rng.normal(0, EXPLORATION.restPieceSigmaPx)));
			p = { x: anchor.x + dx, y: anchor.y + dy };
		} else p = pointInBand(geometry.boardRect, "ownHalf", rng);
	} else p = pointInBand(geometry.boardRect, chosen === "clock" ? "clock" : "offBoard", rng);
	return { x: Math.round(p.x), y: Math.round(p.y) };
}
