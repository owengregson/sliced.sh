/**
 * tools/human-match/strength-audit/cache.ts — one cached capture of `verification-audit.ts`
 * turned into an audit row: every law over the position's full Maia pool, scored against the deep
 * frame and the human move. A position missing any deep root score is excluded whole.
 */

import { createHash } from "node:crypto";
import { cpEffective } from "@core/strength/elo-map";
import { intuitionProb, recognitionDistribution } from "@core/strength/generate-verify";
import type { Eval } from "@typedefs/engine";
import {
	distinctDistribution,
	HEAD_BREADTH,
	independentDistribution,
	interpolate,
	prior,
} from "./laws";
import { METHODS, type Method, type Metrics, metrics, type Row } from "./metrics";

export interface Position {
	id: string;
	gameId: string;
	bucket: number;
	split: "development" | "heldout";
	selfElo: number;
	oppoElo: number;
	humanMove: string;
}
interface Frame {
	complete: boolean;
	depth: number;
	lines: Array<{ pvUci: string[]; score: Eval }>;
}
export interface Capture {
	position: Position;
	policy: { moves: Array<[string, number]>; size: string };
	shallow: Frame;
	deep: Frame;
}

export interface Exclusion {
	position: Position;
	missingDeep: Array<[string, number]>;
	humanMissing: boolean;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const scores = (frame: Frame) =>
	new Map(
		frame.lines.map((l) => {
			if (!l.pvUci[0] || (!Number.isFinite(l.score.cp) && !Number.isFinite(l.score.mate)))
				throw new Error("Invalid engine score");
			return [l.pvUci[0], cpEffective(l.score)] as const;
		})
	);

/** The row of one cached capture (`raw` is its file text), or why the position is excluded. */
export function auditCapture(
	position: Position,
	raw: string,
	samples: number
): { row: Row } | { excluded: Exclusion } {
	const record = JSON.parse(raw) as Capture;
	if (JSON.stringify(position) !== JSON.stringify(record.position))
		throw new Error("Cache/manifest mismatch");
	if (!record.shallow.complete || !record.deep.complete)
		throw new Error(`${position.id}: incomplete frame`);
	if (record.policy.size !== "79m") throw new Error("Wrong policy model");
	const deep = scores(record.deep),
		shallow = scores(record.shallow);
	const missingDeep = record.policy.moves.filter(([uci]) => !deep.has(uci));
	if (missingDeep.length > 0)
		return { excluded: { position, missingDeep, humanMissing: !deep.has(position.humanMove) } };
	const pool = record.policy.moves.map(([uci, p]) => {
		const deepCp = deep.get(uci),
			shallowCp = shallow.get(uci);
		if (deepCp === undefined || shallowCp === undefined)
			throw new Error(`${position.id}: missing ${uci} score`);
		if (!(p > 0) || !Number.isFinite(p)) throw new Error("Invalid policy probability");
		return { uci, p, deepCp, shallowCp };
	});
	const E = position.selfElo;
	const headK = Math.round(interpolate(E, HEAD_BREADTH));
	const laws: Record<Method, Map<string, number>> = {
		raw: prior(pool),
		headDistinct: distinctDistribution(pool, E, "head", `${position.id}:head`, samples),
		sep15Distinct: distinctDistribution(pool, E, "sep15", position.id, samples),
		currentTwo: recognitionDistribution({ survivors: pool, E }),
		independentSep15K: independentDistribution(pool, E, [2, 2, 3]),
		independentHeadK: independentDistribution(pool, E, [headK - 1, headK, headK + 1]),
	};
	const humanCp = deep.get(position.humanMove);
	if (humanCp === undefined) throw new Error("Missing human score");
	const cpLoss = Math.max(...pool.map((c) => c.deepCp)) - humanCp;
	const priorCollision = [...laws.raw.values()].reduce((sum, p) => sum + p * p, 0);
	return {
		row: {
			position,
			cacheSha256: sha256(raw),
			shallowDepth: record.shallow.depth,
			deepDepth: record.deep.depth,
			hasMate: record.deep.lines.some((l) => l.score.mate !== undefined),
			priorCollision,
			newComparableShare: (1 - intuitionProb(E)) * (1 - priorCollision),
			human: { cpLoss, error100: Number(cpLoss >= 100), error300: Number(cpLoss >= 300) },
			methods: Object.fromEntries(
				METHODS.map((method) => [method, metrics(laws[method], pool, position.humanMove)])
			) as Record<Method, Metrics>,
			sep15MonteCarloSensitivity: metrics(
				distinctDistribution(pool, E, "sep15", `${position.id}:replicate`, samples),
				pool,
				position.humanMove
			),
		},
	};
}
