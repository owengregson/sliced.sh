/**
 * tools/human-match/make-fixture/railed-mass.ts — Σ Maia mass the current rails would exclude at
 * a target, printed after a run so the tests' ceilings have a basis.
 */

import type { MaiaSize } from "@core/constants/maia";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { lossCapFor } from "@core/strength/maia-select";
import { hangsPiece } from "@core/strength/move-selector";
import { rankedLines } from "@core/strength/quality";
import type { FixturePosition } from "./types";

export function railedMassAt(p: FixturePosition, size: MaiaSize, E: number): number {
	const policy = p.policy[size];
	if (!policy) return 0;
	const prob = new Map(policy.moves);
	const ranked = rankedLines(p.lines);
	const top = ranked[0];
	if (!top) return 0;
	const winTop = winProb(cpEffective(top.score));
	const cap = lossCapFor(E);
	const alternative = ranked.some((l) => (l.score.mate ?? 0) >= 0);
	let mass = 0;
	for (const line of ranked) {
		const uci = line.pvUci[0] ?? "";
		const lossRaw = winTop - winProb(cpEffective(line.score));
		const mated = alternative && (line.score.mate ?? 0) < 0;
		if (mated || hangsPiece(line, lossRaw, p.fen) || lossRaw > cap) mass += prob.get(uci) ?? 0;
	}
	return mass;
}
