/**
 * Cache-only paired strength proxy; never loads a model or starts an engine.
 * bun tools/human-match/strength-audit-2450.ts [cache] [output.json] [comparisonDraws=20000]
 * Baselines isolate verifier changes on identical actual-rating policy/search inputs.
 */
import "./defines";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRng } from "@core/rng";
import { cpEffective, sigmaFor } from "@core/strength/elo-map";
import {
	type GvCandidate,
	intuitionProb,
	recognitionDistribution,
	verifySigmaFor,
} from "@core/strength/generate-verify";
import type { Eval } from "@typedefs/engine";

type Knots = ReadonlyArray<readonly [number, number]>;
const HEAD_BREADTH: Knots = [
	[800, 2],
	[1400, 3],
	[2000, 4],
	[2500, 5],
	[2800, 5],
];
const HEAD_SIGMA: Knots = [
	[800, 60],
	[1400, 45],
	[2000, 30],
	[2500, 20],
	[2800, 20],
];
const METHODS = [
	"raw",
	"headDistinct",
	"sep15Distinct",
	"currentTwo",
	"independentSep15K",
	"independentHeadK",
] as const;
type Method = (typeof METHODS)[number];

interface Position {
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
interface Capture {
	position: Position;
	policy: { moves: Array<[string, number]>; size: string };
	shallow: Frame;
	deep: Frame;
}

export function interpolate(E: number, knots: Knots): number {
	let previous = knots[0];
	if (previous === undefined) throw new Error("Empty knots");
	if (E <= previous[0]) return previous[1];
	for (const next of knots.slice(1)) {
		if (E <= next[0])
			return previous[1] + ((E - previous[0]) / (next[0] - previous[0])) * (next[1] - previous[1]);
		previous = next;
	}
	return previous[1];
}

export function prior(pool: readonly GvCandidate[]): Map<string, number> {
	const total = pool.reduce((sum, c) => sum + c.p, 0);
	if (!(total > 0)) throw new Error("No probability mass");
	return new Map(pool.map((c) => [c.uci, c.p / total]));
}

/** Exact intuition component + seeded conditional comparison draws. No production overrides. */
export function distinctDistribution(
	pool: readonly GvCandidate[],
	E: number,
	version: "head" | "sep15",
	seed: string,
	samples: number
): Map<string, number> {
	const p = prior(pool);
	const I =
		version === "head"
			? interpolate(E, [
					[800, 0.55],
					[2500, 0.1],
				])
			: intuitionProb(E);
	const base = version === "head" ? Math.round(interpolate(E, HEAD_BREADTH)) : 2;
	const sigma =
		version === "head" ? Math.max(sigmaFor(E), interpolate(E, HEAD_SIGMA)) : verifySigmaFor(E);
	const q = new Map([...p].map(([uci, probability]) => [uci, I * probability]));
	const rng = createRng(seed);
	for (let n = 0; n < samples; n++) {
		const k = Math.min(pool.length, Math.max(2, Math.min(8, base + rng.int(-1, 1))));
		const remaining = [...pool];
		const drawn: GvCandidate[] = [];
		for (let i = 0; i < k; i++) {
			const pick = rng.weighted(
				remaining,
				remaining.map((c) => c.p)
			);
			drawn.push(pick);
			remaining.splice(remaining.indexOf(pick), 1);
		}
		let winner = "";
		let maximum = -Infinity;
		for (const candidate of drawn) {
			const score = (candidate.shallowCp ?? candidate.deepCp) + rng.normal(0, sigma);
			if (score > maximum) {
				maximum = score;
				winner = candidate.uci;
			}
		}
		if (!winner) throw new Error("No winner");
		q.set(winner, (q.get(winner) ?? 0) + (1 - I) / samples);
	}
	return q;
}

/**
 * Offline counterfactual only. Repeated proposals use original p, not the incumbent law.
 * Unscored pairs keep the incumbent; equal finite scores are a fair comparison.
 * Mix the final chain with the same Sep15 intuition; only proposal count is varied.
 */
export function independentDistribution(
	pool: readonly GvCandidate[],
	E: number,
	counts: readonly number[]
): Map<string, number> {
	const p = prior(pool);
	const I = intuitionProb(E);
	const sigma = verifySigmaFor(E);
	const result = new Map([...p].map(([uci, probability]) => [uci, I * probability]));
	for (const count of counts) {
		let current = new Map(p);
		for (let step = 1; step < count; step++) {
			const next = new Map(pool.map((c) => [c.uci, 0]));
			for (const incumbent of pool)
				for (const proposal of pool) {
					const mass = (current.get(incumbent.uci) ?? 0) * (p.get(proposal.uci) ?? 0);
					const comparable = Number.isFinite(incumbent.shallowCp) && Number.isFinite(proposal.shallowCp);
					const accept = comparable
						? 1 / (1 + Math.exp(((incumbent.shallowCp ?? 0) - (proposal.shallowCp ?? 0)) / sigma))
						: 0;
					next.set(incumbent.uci, (next.get(incumbent.uci) ?? 0) + mass * (1 - accept));
					next.set(proposal.uci, (next.get(proposal.uci) ?? 0) + mass * accept);
				}
			current = next;
		}
		for (const [uci, probability] of current)
			result.set(uci, (result.get(uci) ?? 0) + ((1 - I) * probability) / counts.length);
	}
	return result;
}

function metrics(q: ReadonlyMap<string, number>, pool: readonly GvCandidate[], human: string) {
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
type Metrics = ReturnType<typeof metrics>;
interface Row {
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

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
function interval(values: readonly number[]) {
	const rng = createRng("strength-audit-bootstrap-v1");
	const means: number[] = [];
	for (let b = 0; b < 4000; b++) {
		let total = 0;
		for (let i = 0; i < values.length; i++) total += values[rng.int(0, values.length - 1)] ?? 0;
		means.push(total / values.length);
	}
	means.sort((a, b) => a - b);
	return { mean: mean(values), low95: means[100], high95: means[3899] };
}

function summary(name: string, rows: Row[]) {
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
async function main() {
	const cache = process.argv[2] ?? ".scratch/human-verification-2026-09-16";
	const output = process.argv[3] ?? "docs/research/strength-audit-2450-2026-09-16.json";
	const samples = Number(process.argv[4] ?? 20000);
	if (!Number.isInteger(samples) || samples < 1000)
		throw new Error("At least 1000 comparison draws required");
	const manifestText = readFileSync(path.join(cache, "sample.json"), "utf8");
	const manifest = JSON.parse(manifestText) as {
		sourceSha256: string;
		excludedGames: number;
		positions: Position[];
	};
	const positions = manifest.positions.filter((p) => p.selfElo >= 2250 && p.selfElo <= 2800);
	if (new Set(positions.map((p) => p.gameId)).size !== positions.length)
		throw new Error("Repeated games");
	const sources = [
		"src/core/strength/generate-verify.ts",
		"src/core/constants/generate-verify.ts",
		"src/core/strength/elo-map.ts",
		"src/core/strength/constants.ts",
		"src/core/constants/limits.ts",
		"src/core/rng.ts",
	];
	const sourceHashes = Object.fromEntries(
		sources.map((file) => [file, sha256(readFileSync(file, "utf8"))])
	);
	const rows: Row[] = [];
	const excluded: Array<{
		position: Position;
		missingDeep: Array<[string, number]>;
		humanMissing: boolean;
	}> = [];
	for (const position of positions) {
		const raw = readFileSync(path.join(cache, `${position.id}.json`), "utf8");
		const record = JSON.parse(raw) as Capture;
		if (JSON.stringify(position) !== JSON.stringify(record.position))
			throw new Error("Cache/manifest mismatch");
		if (!record.shallow.complete || !record.deep.complete)
			throw new Error(`${position.id}: incomplete frame`);
		if (record.policy.size !== "79m") throw new Error("Wrong policy model");
		const scores = (frame: Frame) =>
			new Map(
				frame.lines.map((l) => {
					if (!l.pvUci[0] || (!Number.isFinite(l.score.cp) && !Number.isFinite(l.score.mate)))
						throw new Error("Invalid engine score");
					return [l.pvUci[0], cpEffective(l.score)] as const;
				})
			);
		const deep = scores(record.deep),
			shallow = scores(record.shallow);
		const missingDeep = record.policy.moves.filter(([uci]) => !deep.has(uci));
		if (missingDeep.length > 0) {
			excluded.push({ position, missingDeep, humanMissing: !deep.has(position.humanMove) });
			continue;
		}
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
		rows.push({
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
		});
	}
	const inRange = (r: Row) => r.position.selfElo >= 2300 && r.position.selfElo <= 2700;
	const heldout = rows.filter((r) => r.position.split === "heldout");
	const groups: Array<[string, Row[]]> = [
		["heldout2300to2700", heldout.filter(inRange)],
		["heldout2400to2500", heldout.filter((r) => Math.abs(r.position.selfElo - 2450) <= 50)],
		["heldout2400Bucket", heldout.filter((r) => r.position.bucket === 2400)],
		["heldout2700Bucket", heldout.filter((r) => r.position.bucket === 2700)],
		["heldout2300to2700NoMate", heldout.filter((r) => inRange(r) && !r.hasMate)],
		["development2300to2700", rows.filter((r) => inRange(r) && r.position.split === "development")],
	];
	for (const file of sources)
		if (sourceHashes[file] !== sha256(readFileSync(file, "utf8")))
			throw new Error("Runtime source changed during audit");
	const summaries = groups
		.filter(([, subset]) => subset.length > 0)
		.map(([name, subset]) => summary(name, subset));
	const captureReport = JSON.parse(
		readFileSync("docs/research/maia-recognition-verification-2026-09-16.json", "utf8")
	) as { provenance: unknown };
	await Bun.write(
		output,
		`${JSON.stringify(
			{
				protocol: "cache-only-strength-v1",
				cache,
				samples,
				bootstrapGames: 4000,
				manifestSha256: sha256(manifestText),
				sourceArchiveSha256: manifest.sourceSha256,
				excludedPriorCalibrationGames: manifest.excludedGames,
				captureProvenance: captureReport.provenance,
				sourceHashes,
				auditSourceSha256: sha256(readFileSync(import.meta.path, "utf8")),
				headBaselineCommit: "4d93134ad4e678d7fe6e76b9c23cf8024325f447",
				methods: {
					headDistinct: "HEAD breadth4-6 at2450, intuition.1132353, sigma21cp; distinct Gaussian argmax",
					sep15Distinct:
						"Sep15 recalibration breadth2/3, intuition.6029412, sigma80cp at2450; distinct Gaussian argmax",
					currentTwo:
						"Current exact two-independent-proposal shallow logistic law, Sep15 intuition/noise",
					independentSep15K:
						"Counterfactual exact sequential independent2/2/3 proposals; current intuition/noise",
					independentHeadK:
						"Counterfactual exact sequential independent historical rating-count proposals; current intuition/noise",
				},
				limitations: [
					"Same actual-rating Maia policies; not a fixed2450 re-query or live effective-rating simulation",
					"All legal roots, no runtime book/rails/search truncation/repetition/tie-band adjustments",
					"Captured SF19 full-network shallow and capped depth12 reference frames, not a new engine run; omit entire positions missing any deep root score",
					"cpEffective clips ordinary evaluations to +-1000cp and maps mate distances to +(1100-distance) or negative",
					"Human actual move is one draw per game; bootstrap resamples games; recurring players and related positions across games are not clustered",
					"Conditional Monte Carlo error is separate from game bootstrap uncertainty",
					"Historical constants applied to SF19 frames isolate verifier changes, not full historical SF18/SF19 pipeline strength",
					"Cached human Chess.com rating does not prove equivalence to model training rating or extension Elo",
				],
				summaries,
				excluded,
				rows,
			},
			null,
			2
		)}\n`
	);
	for (const result of summaries)
		console.log(
			JSON.stringify({
				name: result.name,
				games: result.games,
				human: result.human,
				methods: result.methods,
				paired: result.paired["currentTwo minus sep15Distinct"],
				versusHuman: result.versusHuman.currentTwo,
				seedSensitivity: result.sep15SeedSensitivity,
			})
		);
}

if (import.meta.main) await main();
