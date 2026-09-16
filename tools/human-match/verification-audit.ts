/**
 * Paired verification audit on fresh human games, with immutable captured model/search inputs.
 * bun tools/human-match/verification-audit.ts GAMES.jsonl CACHE_DIR [perBucket=60]
 * Uses one deterministic position per game; excludes games in the earlier strength tuning store.
 * Development/heldout split is by game hash, before inference. No parameter fitting occurs here.
 */
import "./defines";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { humanDepth } from "@core/engine/depth-policy";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { cpEffective } from "@core/strength/elo-map";
import {
	distinctCandidateVerification,
	type GvCandidate,
	intuitionProb,
	recognitionDistribution,
} from "@core/strength/generate-verify";
import { shapedRootSet } from "@service/game-session/recommendation";
import { Chess } from "chess.js";
import { createRefereeEngine, type SearchFrame } from "./engine";
import { createMaiaRunner } from "./maia";

export interface AuditPosition {
	id: string;
	gameId: string;
	split: "development" | "heldout";
	bucket: number;
	selfElo: number;
	oppoElo: number;
	fen: string;
	historyFens: string[];
	humanMove: string;
}

interface Game {
	url: string;
	timeClass: string;
	whiteElo: number;
	blackElo: number;
	pgn: string;
}

interface RecordRow {
	position: AuditPosition;
	policy: PolicyResult;
	shallow: SearchFrame;
	deep: SearchFrame;
}

function hash(value: string): number {
	return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

/** One game is one independent unit, including across Elo buckets. */
export function samplePositions(
	games: Game[],
	excluded: ReadonlySet<string>,
	perBucket: number
): AuditPosition[] {
	const used = new Set<string>();
	const positions: AuditPosition[] = [];
	const sorted = games
		.filter((g) => g.timeClass === "blitz")
		.sort((a, b) => hash(a.url) - hash(b.url));
	for (const bucket of [900, 1400, 1900, 2400, 2700]) {
		let count = 0;
		for (const game of sorted) {
			if (count >= perBucket) break;
			const gameId = game.url.split("/").at(-1) ?? game.url;
			if (used.has(gameId) || excluded.has(gameId)) continue;
			const board = new Chess();
			try {
				board.loadPgn(game.pgn);
			} catch {
				continue;
			}
			const moves = board.history({ verbose: true });
			const clocks = [...game.pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map(
				(m) => (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
			);
			if (moves.length !== clocks.length) continue;
			const candidates = moves
				.map((m, ply) => ({ m, ply }))
				.filter(({ m, ply }) => {
					const rating = m.color === "w" ? game.whiteElo : game.blackElo;
					return (
						ply >= 16 &&
						ply < moves.length - 10 &&
						rating <= 2800 &&
						Math.abs(rating - bucket) <= 150 &&
						(clocks[ply - 2] ?? 0) >= 30000
					);
				});
			const selected = candidates[hash(`${gameId}:position`) % candidates.length];
			if (selected === undefined) continue;
			const { m, ply } = selected;
			if (new Chess(m.before).moves().length < 2) continue;
			positions.push({
				id: `${gameId}-${ply}`,
				gameId,
				bucket,
				split: hash(`${gameId}:split`) % 4 === 0 ? "development" : "heldout",
				selfElo: m.color === "w" ? game.whiteElo : game.blackElo,
				oppoElo: m.color === "w" ? game.blackElo : game.whiteElo,
				fen: m.before,
				historyFens: moves.slice(Math.max(0, ply - 7), ply + 1).map((move) => move.before),
				humanMove: m.from + m.to + (m.promotion ?? ""),
			});
			used.add(gameId);
			count++;
		}
	}
	return positions;
}

/** Preserve the exact intuition component so Monte Carlo never invents zero tail probability. */
export function legacyDistribution(
	pool: GvCandidate[],
	E: number,
	seed: string,
	samples = 20000
): Map<string, number> {
	const total = pool.reduce((sum, c) => sum + c.p, 0);
	const intuitive = intuitionProb(E);
	const q = new Map(pool.map((c) => [c.uci, (intuitive * c.p) / total]));
	const rng = { ...createRng(seed), chance: () => false };
	for (let i = 0; i < samples; i++) {
		const result = distinctCandidateVerification({ survivors: pool, E, rng });
		if (result === null) return new Map(pool.map((c) => [c.uci, c.p / total]));
		q.set(result.uci, (q.get(result.uci) ?? 0) + (1 - intuitive) / samples);
	}
	return q;
}

function metrics(q: ReadonlyMap<string, number>, human: string) {
	const p = q.get(human) ?? 0;
	let top = "";
	let confidence = 0;
	let brier = 1 - 2 * p;
	for (const [uci, value] of q) {
		brier += value * value;
		if (value > confidence) {
			top = uci;
			confidence = value;
		}
	}
	return { nll: p > 0 ? -Math.log(p) : null, match: top === human ? 1 : 0, p, brier, confidence };
}

function bootstrapMean(values: number[]): [number, number, number] {
	const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
	const rng = createRng("verification-audit-bootstrap-v1");
	const means: number[] = [];
	for (let i = 0; i < 2000; i++) {
		let sum = 0;
		for (let j = 0; j < values.length; j++) sum += values[rng.int(0, values.length - 1)] ?? 0;
		means.push(sum / values.length);
	}
	means.sort((a, b) => a - b);
	return [mean, means[50] ?? mean, means[1949] ?? mean];
}

async function main() {
	const [source, cache, perBucketText] = process.argv.slice(2);
	if (!source || !cache) throw new Error("Expected GAMES.jsonl CACHE_DIR [perBucket=60]");
	await mkdir(cache, { recursive: true });
	const games = (await Bun.file(source).text())
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Game);
	const oldStore = path.resolve(".scratch/bot-strength/store");
	const excluded = new Set(
		(await readdir(oldStore).catch(() => [] as string[])).map((f) => f.split("_")[1] ?? "")
	);
	const positions = samplePositions(games, excluded, Number(perBucketText ?? 60));
	const sourceSha256 = createHash("sha256")
		.update(new Uint8Array(await Bun.file(source).arrayBuffer()))
		.digest("hex");
	await Bun.write(
		path.join(cache, "sample.json"),
		JSON.stringify({ sourceSha256, excludedGames: excluded.size, positions }, null, 2)
	);
	const missing = [];
	for (const position of positions)
		if (!(await Bun.file(path.join(cache, `${position.id}.json`)).exists())) missing.push(position);
	if (missing.length > 0) {
		const maia = await createMaiaRunner(1);
		const engine = await createRefereeEngine({ variant: "full", threads: 2, hashMb: 64 });
		try {
			for (const [i, position] of missing.entries()) {
				const policy = await maia.query(
					"79m",
					position.historyFens,
					position.selfElo,
					position.oppoElo
				);
				const shallow = await engine.search({
					fen: position.fen,
					multiPv: policy.moves.length,
					depth: humanDepth(position.selfElo),
					movetimeMs: 3000,
				});
				const deep = await engine.search({
					fen: position.fen,
					multiPv: policy.moves.length,
					depth: 12,
					movetimeMs: 1500,
				});
				if (!shallow.complete || !deep.complete) throw new Error(`${position.id}: incomplete frame`);
				await Bun.write(
					path.join(cache, `${position.id}.json`),
					JSON.stringify({ position, policy, shallow, deep })
				);
				if ((i + 1) % 10 === 0) console.log(`captured ${i + 1}/${missing.length}`);
			}
		} finally {
			await maia.dispose();
			engine.dispose();
		}
	}
	const rows = [];
	for (const position of positions) {
		const record = (await Bun.file(path.join(cache, `${position.id}.json`)).json()) as RecordRow;
		if (JSON.stringify(record.position) !== JSON.stringify(position))
			throw new Error(`${position.id}: cached model inputs differ; use a fresh cache directory`);
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
		rows.push({
			id: position.id,
			split: position.split,
			bucket: position.bucket,
			raw: metrics(raw, position.humanMove),
			old: metrics(old, position.humanMove),
			corrected: metrics(corrected, position.humanMove),
			underRootFloor: (raw.get(position.humanMove) ?? 0) < 0.005,
			shapedMass,
			humanInShapedSet: shaped.has(position.humanMove),
			shallowDepth: record.shallow.depth,
			requestedDepth: humanDepth(position.selfElo),
		});
	}
	const summary = [];
	for (const split of ["development", "heldout"])
		for (const bucket of [0, 900, 1400, 1900, 2400, 2700]) {
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
	const report = {
		sourceSha256,
		excludedGames: excluded.size,
		sampleCount: positions.length,
		note:
			"Isolated verifier audit, all legal Maia moves; excludes book, rails, timing, platform rating conversion and runtime root truncation. SF19 full net. No parameter fitting.",
		summary,
		rows,
	};
	await Bun.write(path.join(cache, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) await main();
