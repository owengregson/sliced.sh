/** The record of a Maia pick — rank, meters and the `maia:` rationale rows. */

import { MAIA } from "@core/constants/maia";
import type { PolicyResult } from "@core/policy/types";
import { fmt } from "../format";
import type { MaiaDraw, MaiaSurvivors } from "./types";

/**
 * The record of a Maia pick `uci` over `set` — the rank among the survivors, the `maia:` and
 * `maia wdl:` rows — for whichever stage chose it (the weighted draw, or generate-and-verify).
 */
export function maiaDrawRecord(
	set: MaiaSurvivors,
	policy: PolicyResult,
	E: number,
	uci: string,
	moved: { klFromMaia: number; tieBand: number; practicalBand: number },
	rationale: string[]
): MaiaDraw {
	const { prob, survivors, scoredMass, scoredMassBefore, unscoredMass, railedMass, extra } = set;
	const p = prob.get(uci) ?? 0;
	const ordered = [...survivors].sort((a, b) => (prob.get(b.uci) ?? 0) - (prob.get(a.uci) ?? 0));
	const maiaRank = ordered.findIndex((c) => c.uci === uci) + 1;
	const ms = policy.ms === undefined ? "n/a" : fmt(policy.ms, 0);
	const added = extra > 0 ? ` (+${extra} from searchmoves)` : "";
	const guards =
		fmt(scoredMassBefore) !== fmt(scoredMass) ? ` (guards left ${fmt(scoredMass)})` : "";
	const railed = railedMass > 0 ? ` railed ${fmt(railedMass)}` : "";
	const kl = moved.klFromMaia > 0 ? ` KL ${fmt(moved.klFromMaia)}` : "";
	rationale.push(
		`maia: ${policy.size} E=${fmt(E, 0)} p=${fmt(p)} rank ${maiaRank}/${survivors.length} survivors scored mass ${fmt(scoredMassBefore)}${guards}${added} unscored ${fmt(unscoredMass)}${railed}${kl} ${ms} ms`
	);
	const [loss, draw, win] = policy.wdl;
	rationale.push(`maia wdl: ${fmt(loss, 2)}/${fmt(draw, 2)}/${fmt(win, 2)}`);
	return {
		uci,
		p,
		maiaRank,
		scored: set.scored,
		extra,
		scoredMass,
		scoredMassBefore,
		unscoredMass,
		railedMass,
		survivors: survivors.length,
		klFromMaia: moved.klFromMaia,
		tieBand: moved.tieBand,
		practicalBand: moved.practicalBand,
		temperature: MAIA.temperature,
	};
}
