/**
 * tools/human-match/strength-audit/metrics.ts — how one law is scored against the deep reference
 * and the human move, and how rows are summarised with game-bootstrap intervals.
 */

import type { GvCandidate } from "@core/strength/generate-verify";
import { bootstrapMeans, mean } from "../../lib/stats";
import type { Position } from "./cache";
import { prior } from "./laws";

export const METHODS = [
	"raw",
	"headDistinct",
	"sep15Distinct",
	"currentTwo",
	"independentSep15K",
	"independentHeadK",
] as const;
export type Method = (typeof METHODS)[number];

export function metrics(
	q: ReadonlyMap<string, number>,
	pool: readonly GvCandidate[],
	human: string
) {
	const p = prior(pool);
	const best = Math.max(...pool.map((c) => c.deepCp));
	let cpLoss = 0,
		error100 = 0,
		error300 = 0,
		rarePrior = 0,
		entropy = 0,
		kl = 0;
	for (const candidate of pool) {
		const mass = q.get(candidate.uci) ?? 0;
		const loss = Math.max(0, best - candidate.deepCp);
		cpLoss += mass * loss;
		error100 += mass * Number(loss >= 100);
		error300 += mass * Number(loss >= 300);
		rarePrior += mass * Number((p.get(candidate.uci) ?? 0) < 0.005);
		if (mass > 0) {
			entropy -= mass * Math.log(mass);
			kl += mass * Math.log(mass / (p.get(candidate.uci) ?? 0));
		}
	}
	const humanProbability = q.get(human) ?? 0;
	if (!(humanProbability > 0)) throw new Error(`Human move outside probability support: ${human}`);
	const total = [...q.values()].reduce((a, b) => a + b, 0);
	if (Math.abs(total - 1) > 1e-8) throw new Error(`Distribution mass ${total}`);
	return {
		cpLoss,
		error100,
		error300,
		nll: -Math.log(humanProbability),
		humanProbability,
		rarePrior,
		entropy,
		kl,
	};
}
export type Metrics = ReturnType<typeof metrics>;

export interface Row {
	position: Position;
	cacheSha256: string;
	shallowDepth: number;
	deepDepth: number;
	hasMate: boolean;
	priorCollision: number;
	newComparableShare: number;
	human: { cpLoss: number; error100: number; error300: number };
	methods: Record<Method, Metrics>;
	sep15MonteCarloSensitivity: Metrics;
}

/** Games resampled per bootstrap interval. */
export const BOOTSTRAP_GAMES = 4000;

function interval(values: readonly number[]) {
	const means = bootstrapMeans(values, "strength-audit-bootstrap-v1", BOOTSTRAP_GAMES);
	return { mean: mean(values), low95: means[100], high95: means[3899] };
}

export function summary(name: string, rows: Row[]) {
	const keys = [
		"cpLoss",
		"error100",
		"error300",
		"nll",
		"humanProbability",
		"rarePrior",
		"entropy",
		"kl",
	] as const;
	const qualityKeys = ["cpLoss", "error100", "error300"] as const;
	const pairs: Array<[Method, Method]> = [
		["sep15Distinct", "headDistinct"],
		["currentTwo", "sep15Distinct"],
		["currentTwo", "headDistinct"],
		["currentTwo", "raw"],
		["independentSep15K", "currentTwo"],
		["independentHeadK", "currentTwo"],
	];
	return {
		name,
		games: rows.length,
		selfElo: {
			min: Math.min(...rows.map((r) => r.position.selfElo)),
			mean: mean(rows.map((r) => r.position.selfElo)),
			max: Math.max(...rows.map((r) => r.position.selfElo)),
		},
		matePositions: rows.filter((r) => r.hasMate).length,
		human: Object.fromEntries(
			qualityKeys.map((key) => [key, interval(rows.map((r) => r.human[key]))])
		),
		methods: Object.fromEntries(
			METHODS.map((method) => [
				method,
				Object.fromEntries(keys.map((key) => [key, mean(rows.map((r) => r.methods[method][key]))])),
			])
		),
		paired: Object.fromEntries(
			pairs.map(([a, b]) => [
				`${a} minus ${b}`,
				Object.fromEntries(
					keys.map((key) => [key, interval(rows.map((r) => r.methods[a][key] - r.methods[b][key]))])
				),
			])
		),
		versusHuman: Object.fromEntries(
			METHODS.map((method) => [
				method,
				Object.fromEntries(
					qualityKeys.map((key) => [
						key,
						interval(rows.map((r) => r.methods[method][key] - r.human[key])),
					])
				),
			])
		),
		meanPriorCollision: mean(rows.map((r) => r.priorCollision)),
		meanNewComparableShare: mean(rows.map((r) => r.newComparableShare)),
		sep15SeedSensitivity: Object.fromEntries(
			keys.map((key) => [
				key,
				mean(rows.map((r) => r.sep15MonteCarloSensitivity[key] - r.methods.sep15Distinct[key])),
			])
		),
	};
}
