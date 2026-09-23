/**
 * tools/human-match/verification-audit/report.ts — every captured position scored under the raw
 * policy, the legacy verifier and the corrected law, then summarised per split and bucket with
 * paired bootstrap deltas.
 */

import { humanDepth } from "@core/engine/depth-policy";
import { cpEffective } from "@core/strength/elo-map";
import { type GvCandidate, recognitionDistribution } from "@core/strength/generate-verify";
import { shapedRootSet } from "@service/game-session/recommendation";
import { bootstrapMeans } from "../../lib/stats";
import type { CapturedRecord } from "./capture";
import { lawMetrics, legacyDistribution } from "./laws";
import { AUDIT_BUCKETS } from "./sample";

export function auditRow(record: CapturedRecord) {
	const { position } = record;
	const deep = new Map(record.deep.lines.map((l) => [l.pvUci[0], cpEffective(l.score)]));
	const shallow = new Map(record.shallow.lines.map((l) => [l.pvUci[0], cpEffective(l.score)]));
	const pool: GvCandidate[] = record.policy.moves.map(([uci, p]) => ({
		uci,
		p,
		deepCp: deep.get(uci) ?? 0,
		...(shallow.has(uci) ? { shallowCp: shallow.get(uci) as number } : {}),
	}));
	const raw = new Map(record.policy.moves);
	const old = legacyDistribution(pool, position.selfElo, position.id);
	const corrected = recognitionDistribution({ survivors: pool, E: position.selfElo });
	const shaped = new Set(
		shapedRootSet(
			record.policy,
			position.fen,
			record.deep.bestmove === null ? [] : [record.deep.bestmove]
		)
	);
	const shapedMass = record.policy.moves.reduce(
		(mass, [uci, p]) => mass + (shaped.has(uci) ? p : 0),
		0
	);
	return {
		id: position.id,
		split: position.split,
		bucket: position.bucket,
		raw: lawMetrics(raw, position.humanMove),
		old: lawMetrics(old, position.humanMove),
		corrected: lawMetrics(corrected, position.humanMove),
		underRootFloor: (raw.get(position.humanMove) ?? 0) < 0.005,
		shapedMass,
		humanInShapedSet: shaped.has(position.humanMove),
		shallowDepth: record.shallow.depth,
		requestedDepth: humanDepth(position.selfElo),
	};
}

export type AuditRow = ReturnType<typeof auditRow>;

function bootstrapMean(values: number[]): [number, number, number] {
	const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
	const means = bootstrapMeans(values, "verification-audit-bootstrap-v1", 2000);
	return [mean, means[50] ?? mean, means[1949] ?? mean];
}

/** Per split, all buckets together (`bucket` 0) and then each bucket. */
export function auditSummary(rows: readonly AuditRow[]) {
	const summary = [];
	for (const split of ["development", "heldout"])
		for (const bucket of [0, ...AUDIT_BUCKETS]) {
			const subset = rows.filter((r) => r.split === split && (bucket === 0 || r.bucket === bucket));
			if (subset.length === 0) continue;
			const methods = ["raw", "old", "corrected"] as const;
			if (subset.some((r) => methods.some((method) => r[method].nll === null)))
				throw new Error("A legal human move has zero probability; audit cannot report finite NLL");
			summary.push({
				split,
				bucket,
				n: subset.length,
				methods: Object.fromEntries(
					methods.map((method) => [
						method,
						{
							nll: subset.reduce((s, r) => s + (r[method].nll ?? 0), 0) / subset.length,
							zeroProbability: subset.filter((r) => r[method].nll === null).length,
							match: subset.reduce((s, r) => s + r[method].match, 0) / subset.length,
							brier: subset.reduce((s, r) => s + r[method].brier, 0) / subset.length,
							meanHumanProbability: subset.reduce((s, r) => s + r[method].p, 0) / subset.length,
						},
					])
				),
				deltaNllVsOld: bootstrapMean(subset.map((r) => (r.corrected.nll ?? 0) - (r.old.nll ?? 0))),
				deltaNllVsRaw: bootstrapMean(subset.map((r) => (r.corrected.nll ?? 0) - (r.raw.nll ?? 0))),
				deltaHumanProbabilityVsOld: bootstrapMean(subset.map((r) => r.corrected.p - r.old.p)),
				deltaBrierVsOld: bootstrapMean(subset.map((r) => r.corrected.brier - r.old.brier)),
				deltaMatchVsOld: bootstrapMean(subset.map((r) => r.corrected.match - r.old.match)),
				humanUnderRootFloor: subset.filter((r) => r.underRootFloor).length,
				meanShapedMass: subset.reduce((sum, r) => sum + r.shapedMass, 0) / subset.length,
				humanOutsideShapedSet: subset.filter((r) => !r.humanInShapedSet).length,
				shallowDepthReached: subset.filter((r) => r.shallowDepth >= r.requestedDepth).length,
			});
		}
	return summary;
}
