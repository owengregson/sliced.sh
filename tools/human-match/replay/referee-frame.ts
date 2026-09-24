/**
 * tools/human-match/replay/referee-frame.ts — a row's referee frame searched the way the
 * pipeline does: MultiPV breadth by rating, one extra `searchmoves` pass for Maia's unscored
 * favourites, and a separate single-root score of the human move when the pool never ranked it
 * (used for the human baseline only — never in the pool).
 */

import { legalMoves } from "@core/chess/san";
import { MAIA } from "@core/constants/maia";
import { SEARCH_BUDGET } from "@core/constants/search";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { PolicyResult } from "@core/policy/types";
import {
	maiaExtraSearchmoves,
	maiaUnscoredMoves,
	mergeLines,
} from "@service/game-session/recommendation";
import type { RefereeEngine } from "../../lib/engine/types";
import type { CorpusRow, FrameRecord } from "./corpus";

/** Referee breadth for a sampling target, as `searchBudget` sizes it for Maia mode. */
export function breadthFor(targetElo: number, legal: number): number {
	const band = SEARCH_BUDGET.selectionCandidates.find((b) => targetElo <= b.maxElo)?.count ?? 0;
	const wanted = Math.max(SEARCH_BUDGET.multiPvMedium, band);
	return legal > 0 ? Math.min(wanted, legal) : wanted;
}

export async function refereeFrame(
	engine: RefereeEngine,
	row: CorpusRow,
	policy: PolicyResult | null,
	movetimeMs: number
): Promise<FrameRecord> {
	const legal = legalMoves(row.fen);
	const main = await engine.search({
		fen: row.fen,
		movetimeMs,
		depth: automaticDepthForElo(row.selfElo),
		multiPv: breadthFor(row.selfElo, legal.length),
	});
	let lines = main.lines;
	const extra: string[] = [];
	if (policy) {
		const searchmoves = maiaExtraSearchmoves(maiaUnscoredMoves(policy, lines, row.fen));
		if (searchmoves.length > 0) {
			const pass = await engine.search({
				fen: row.fen,
				movetimeMs: Math.max(SEARCH_BUDGET.minMovetimeMs, Math.min(MAIA.extraSearchMs, movetimeMs)),
				multiPv: searchmoves.length,
				searchmoves,
			});
			lines = mergeLines(lines, pass.lines);
			for (const line of pass.lines) if (line.pvUci[0] !== undefined) extra.push(line.pvUci[0]);
		}
	}
	const record: FrameRecord = { lines, bestmove: main.bestmove, extra };
	if (legal.includes(row.humanMove) && !lines.some((l) => l.pvUci[0] === row.humanMove)) {
		const own = await engine.search({
			fen: row.fen,
			movetimeMs,
			depth: automaticDepthForElo(row.selfElo),
			multiPv: 1,
			searchmoves: [row.humanMove],
		});
		const line = own.lines[0];
		if (line) record.humanLine = line;
	}
	return record;
}
