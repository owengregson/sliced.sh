/**
 * tools/timing-calibration/cap-check/items.ts — the positions `cap-check.ts` searches twice: the
 * capped and the full movetime, MultiPV and depth cap of `ownMoveBudget` at each row.
 */

import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { SEARCH_BUDGET } from "@core/constants/search";
import { TABLEBASE } from "@core/constants/tablebase";
import { isMaxStrength } from "@core/strength/max-strength";
import { pieceCount } from "@core/tablebase/probe";
import { tcClass } from "@core/timing/features";
import {
	maiaPlaysOpening,
	maiaSearchMode,
	ownMoveBudget,
} from "@service/game-session/recommendation";
import { wideBandOf } from "../common";
import type { ReplayData } from "../sim";

export type CapItem = {
	cell: string;
	kind: "book" | "recapture";
	fen: string;
	moves: string[];
	move: string;
	rating: number;
	full: number;
	cap: number;
	multiPv: number;
	depth: number;
};

/**
 * The replay rows where the fast-reply cap applies (a book answer Maia does not play, or a
 * decided recapture; not max strength, not in tablebase range) and actually shortens the search,
 * grouped by time class × 400-Elo band × kind.
 */
export function cappedItems(data: ReplayData): Map<string, CapItem[]> {
	const byCell = new Map<string, CapItem[]>();
	for (const side of data.sides) {
		for (const rr of side.rows) {
			const r = rr.row;
			if (isMaxStrength(r.rating) || (pieceCount(r.fen) ?? 0) <= TABLEBASE.maxPieces) continue;
			const book = r.inBook && !maiaPlaysOpening({ targetElo: r.rating, form: 0 });
			const kind = book ? "book" : rr.recaptureDecided ? "recapture" : null;
			if (!kind) continue;
			const cls = tcClass(r.baseMs / 1000, r.incMs / 1000);
			const budget = ownMoveBudget(
				{
					fen: r.fen,
					ply: r.ply,
					myClockMs: r.clockMs,
					oppClockMs: r.oppClockMs,
					timeControl: { baseMs: r.baseMs, incMs: r.incMs },
					tau: 0.5,
					budgetUsedRatio: r.baseMs > 0 ? Math.max(0, 1 - r.clockMs / r.baseMs) : 0,
					targetElo: r.rating,
					form: 0,
					maia: maiaSearchMode({ targetElo: r.rating, policy: true, clockRace: false }),
				},
				DEFAULT_SETTINGS
			);
			const cap = Math.min(budget.movetimeMs, SEARCH_BUDGET.fastReplyMs[cls]);
			if (cap >= budget.movetimeMs) continue;
			const cell = `${r.tc}|${wideBandOf(r.rating)}|${kind}`;
			const list = byCell.get(cell) ?? [];
			list.push({
				cell,
				kind,
				fen: side.game.fens[0] as string,
				moves: side.game.ucis.slice(0, r.ply),
				move: kind === "book" ? r.move : (rr.pondered ?? r.move),
				rating: r.rating,
				full: budget.movetimeMs,
				cap,
				multiPv: budget.multiPv,
				depth: budget.depthCap,
			});
			byCell.set(cell, list);
		}
	}
	return byCell;
}
