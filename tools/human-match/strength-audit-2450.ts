/**
 * Cache-only paired strength proxy; never loads a model or starts an engine.
 * bun tools/human-match/strength-audit-2450.ts [cache] [output.json] [comparisonDraws=20000]
 * Baselines isolate verifier changes on identical actual-rating policy/search inputs.
 * The parts live in `strength-audit/`: the laws, the per-capture row and the metrics/summary.
 */
import "./defines";
import { readFileSync } from "node:fs";
import path from "node:path";
import { auditCapture, type Exclusion, type Position, sha256 } from "./strength-audit/cache";
import { BOOTSTRAP_GAMES, type Row, summary } from "./strength-audit/metrics";

export {
	distinctDistribution,
	independentDistribution,
	interpolate,
	prior,
} from "./strength-audit/laws";

/** The audit's own source — this entry and its parts, in a fixed order — as one digest. */
const AUDIT_SOURCES = [
	import.meta.path,
	path.join(import.meta.dir, "strength-audit/laws.ts"),
	path.join(import.meta.dir, "strength-audit/cache.ts"),
	path.join(import.meta.dir, "strength-audit/metrics.ts"),
];
const auditSourceSha256 = (): string =>
	sha256(AUDIT_SOURCES.map((file) => readFileSync(file, "utf8")).join(""));

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
	const excluded: Exclusion[] = [];
	for (const position of positions) {
		const outcome = auditCapture(
			position,
			readFileSync(path.join(cache, `${position.id}.json`), "utf8"),
			samples
		);
		if ("excluded" in outcome) excluded.push(outcome.excluded);
		else rows.push(outcome.row);
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
				bootstrapGames: BOOTSTRAP_GAMES,
				manifestSha256: sha256(manifestText),
				sourceArchiveSha256: manifest.sourceSha256,
				excludedPriorCalibrationGames: manifest.excludedGames,
				captureProvenance: captureReport.provenance,
				sourceHashes,
				auditSourceSha256: auditSourceSha256(),
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
