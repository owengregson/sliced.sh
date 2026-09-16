/**
 * tools/human-match/replay.ts — the human move-match harness (§8.1 steps 2–3 of
 * docs/research/human-move-selection-ideas-2026-09-13.md): *does our wrapper make the bot's move
 * distribution more or less like a human's at that rating?*
 *
 * For every corpus position it runs the **full selection wrapper** — the referee lines, Maia at
 * `selfElo` = the player's rating and `oppoElo` = the opponent's, the rails, the draw — as repeated
 * seeded `selectMove` calls (`--draws`, default 2000) to estimate the final sampling distribution
 * `q(m)`, and reports per rating bucket (1000 / 1300 / 1600 / 1900 / 2200 / 2500, nearest):
 *
 *   primary    E[log q(m_human)], top-1 agreement, E[q(m_human)] — and the same for raw Maia `p`;
 *   secondary  ACPL, inaccuracy / mistake / blunder rates (≥ 10 / 20 / 30 % win-probability drop),
 *              piece-hang rate per 40 moves, mate-found rate, same-piece-as-last-move rate, lag-1
 *              autocorrelation of loss — each for the bot (expectation under `q`) **and** for the
 *              humans of the same bucket, so every secondary number is a target, not a guess;
 *   meters     mean `klFromMaia`, `railedMass`, `unscoredMass`, Maia's share of the draws.
 *
 * Inputs
 *   --corpus FILE.jsonl   rows from tools/data/10_sample_lichess.py (schema in 10_human_match.md)
 *   --frames FILE.json    referee frames keyed by row id (written by an earlier --engine run via
 *                         --frames-out), or --engine to search with the vendored Stockfish under Bun
 *                         the way the pipeline does: MultiPV breadth by rating, one extra
 *                         `searchmoves` pass for Maia's unscored favourites, and a separate
 *                         single-root score of the human move when the pool never ranked it
 *                         (used for the human baseline only — never in the pool);
 *   --policies FILE.json  Maia answers keyed by row id (from --policies-out), or --maia to run the
 *                         shipped ONNX models (size by `maiaSizeFor(selfElo)`, or --size);
 *   --fixture             smoke run on test/fixtures/strength/maia-draw.json: its lines and 5M
 *                         policies (the fixture predates the 79M-only package of 2026-09-13 and
 *                         keeps the 5M / 23M answers), with a **synthetic** human move drawn once
 *                         from Maia — every metric path runs, none of the numbers mean anything.
 *
 *   --draws N --seed S --limit N --movetime MS --size 79m --out report.md --json report.json
 *
 * Cost is the referee search (`--engine`): ≈ 0.6–0.9 s per position; cache with --frames-out.
 */

import "./defines";
import path from "node:path";
import { parseFen, plyOf } from "@core/chess/fen";
import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves, parseUci } from "@core/chess/san";
import { MAIA, type MaiaSize } from "@core/constants/maia";
import { SEARCH_BUDGET } from "@core/constants/search";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import { maiaSizeFor } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { createSelectionState, hangsPiece, selectMove } from "@core/strength/move-selector";
import { heuristicPrior } from "@core/strength/prior";
import { rankedLines } from "@core/strength/quality";
import type { SelectionContext } from "@core/strength/types";
import {
	maiaExtraSearchmoves,
	maiaUnscoredMoves,
	mergeLines,
} from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { createRefereeEngine, type RefereeEngine, ROOT } from "./engine";
import { createMaiaRunner, type MaiaRunner } from "./maia";

// ── inputs ────────────────────────────────────────────────────────────────────────────────────

/** One corpus position (JSONL). `tools/data/10_human_match.md` is the normative schema. */
export interface CorpusRow {
	/** Unique per row; `${gameId}:${ply}` by convention. */
	id?: string;
	gameId?: string;
	/** Half-moves played before this position. */
	ply: number;
	fen: string;
	/** ≤ `MAIA_INPUT.history` FENs oldest → newest, the last equal to `fen`. */
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	/** The move the human played, UCI. */
	humanMove: string;
	/** The mover's clock before the move, ms. */
	clockMs: number;
	oppClockMs?: number;
	baseMs?: number;
	incrementMs?: number;
	/** The opponent's last move, UCI. */
	lastMove?: string;
	/** The mover's previous move, UCI. */
	prevOwnMove?: string;
	thinkMs?: number;
	bucket?: number;
}

export interface FrameRecord {
	lines: EvalLine[];
	bestmove: string | null;
	/** Roots the extra `searchmoves` pass added to `lines`. */
	extra: string[];
	/** The human move's own referee line when the pool never scored it (baseline only). */
	humanLine?: EvalLine;
}

interface Args {
	corpus?: string;
	frames?: string;
	framesOut?: string;
	engine: boolean;
	policies?: string;
	policiesOut?: string;
	maia: boolean;
	fixture: boolean;
	size?: MaiaSize;
	draws: number;
	seed: string;
	limit: number;
	movetime: number;
	out?: string;
	json?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		engine: false,
		maia: false,
		fixture: false,
		draws: 2000,
		seed: "human-match",
		limit: 0,
		movetime: SEARCH_BUDGET.moveMs.blitz,
	};
	const take = (i: number): string => {
		const v = argv[i + 1];
		if (v === undefined) throw new Error(`${argv[i]} needs a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--corpus":
				args.corpus = take(i++);
				break;
			case "--frames":
				args.frames = take(i++);
				break;
			case "--frames-out":
				args.framesOut = take(i++);
				break;
			case "--engine":
				args.engine = true;
				break;
			case "--policies":
				args.policies = take(i++);
				break;
			case "--policies-out":
				args.policiesOut = take(i++);
				break;
			case "--maia":
				args.maia = true;
				break;
			case "--fixture":
				args.fixture = true;
				break;
			case "--size":
				args.size = take(i++) as MaiaSize;
				break;
			case "--draws":
				args.draws = Number(take(i++));
				break;
			case "--seed":
				args.seed = take(i++);
				break;
			case "--limit":
				args.limit = Number(take(i++));
				break;
			case "--movetime":
				args.movetime = Number(take(i++));
				break;
			case "--out":
				args.out = take(i++);
				break;
			case "--json":
				args.json = take(i++);
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	if (!args.fixture && !args.corpus) throw new Error("--corpus FILE or --fixture is required");
	return args;
}

export const BUCKETS = [1000, 1300, 1600, 1900, 2200, 2500] as const;

export function bucketOf(elo: number): number {
	let best: number = BUCKETS[0];
	for (const b of BUCKETS) if (Math.abs(b - elo) < Math.abs(best - elo)) best = b;
	return best;
}

function rowId(row: CorpusRow, index: number): string {
	return row.id ?? (row.gameId !== undefined ? `${row.gameId}:${row.ply}` : `row:${index}`);
}

/** Referee breadth for a sampling target, as `searchBudget` sizes it for Maia mode. */
function breadthFor(targetElo: number, legal: number): number {
	const band = SEARCH_BUDGET.selectionCandidates.find((b) => targetElo <= b.maxElo)?.count ?? 0;
	const wanted = Math.max(SEARCH_BUDGET.multiPvMedium, band);
	return legal > 0 ? Math.min(wanted, legal) : wanted;
}

// ── corpus sources ────────────────────────────────────────────────────────────────────────────

async function readCorpus(file: string, limit: number): Promise<CorpusRow[]> {
	const text = await Bun.file(file).text();
	const rows: CorpusRow[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		rows.push(JSON.parse(trimmed) as CorpusRow);
		if (limit > 0 && rows.length >= limit) break;
	}
	return rows;
}

interface FixtureFile {
	positions: Array<{
		index: number;
		fen: string;
		historyFens: string[];
		selfElo: number;
		oppoElo: number;
		ply: number;
		policy: Partial<
			Record<FixturePolicyKey, { moves: Array<[string, number]>; wdl: [number, number, number] }>
		>;
		engine: { searchmoves: string[]; bestmove: string | null };
		lines: EvalLine[];
	}>;
}

/**
 * The keys `maia-draw.json` stores its distributions under. The checked-in fixture was written
 * before the package narrowed to the 79M model (2026-09-13) and keeps the real 5M and 23M
 * answers — they are what the pure selector tests replay — so the fixture's keys are wider than
 * the shipped `MaiaSize`.
 */
type FixturePolicyKey = MaiaSize | "5m" | "23m";
const FIXTURE_DEFAULT_KEY: FixturePolicyKey = "5m";

/** The checked-in fixture as a corpus: synthetic human moves, one seeded draw from Maia each. */
async function fixtureCorpus(
	size: FixturePolicyKey,
	seed: string,
	limit: number
): Promise<{
	rows: CorpusRow[];
	frames: Map<string, FrameRecord>;
	policies: Map<string, PolicyResult>;
}> {
	const file = (await Bun.file(
		path.join(ROOT, "test/fixtures/strength/maia-draw.json")
	).json()) as FixtureFile;
	const rng = createRng(`${seed}:synthetic-human`);
	const rows: CorpusRow[] = [];
	const frames = new Map<string, FrameRecord>();
	const policies = new Map<string, PolicyResult>();
	const source = limit > 0 ? file.positions.slice(0, limit) : file.positions;
	for (const p of source) {
		const policy = p.policy[size];
		if (!policy) throw new Error(`fixture has no ${size} policy`);
		const id = `fixture:${p.index}`;
		const humanMove = rng.weighted(
			policy.moves.map(([uci]) => uci),
			policy.moves.map(([, prob]) => prob)
		);
		rows.push({
			id,
			gameId: "fixture",
			ply: p.ply,
			fen: p.fen,
			historyFens: p.historyFens,
			selfElo: p.selfElo,
			oppoElo: p.oppoElo,
			humanMove,
			clockMs: 90_000,
			oppClockMs: 90_000,
			baseMs: 180_000,
			incrementMs: 0,
		});
		frames.set(id, { lines: p.lines, bestmove: p.engine.bestmove, extra: [] });
		// `PolicyResult.size` is the shipped type; the report header names the fixture key.
		policies.set(id, { moves: policy.moves, wdl: policy.wdl, size: MAIA.defaultSize });
	}
	return { rows, frames, policies };
}

// ── referee and policy ────────────────────────────────────────────────────────────────────────

async function refereeFrame(
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

// ── per-row replay ────────────────────────────────────────────────────────────────────────────

interface RowResult {
	id: string;
	gameId: string | undefined;
	ply: number;
	bucket: number;
	legal: number;
	/** `q(m)` over the drawn moves. */
	q: Map<string, number>;
	sources: Map<ChosenMove["source"], number>;
	meters: { kl: number; railed: number; unscored: number; n: number };
	humanScored: boolean;
	/** Human move: raw Maia p, and the row's loss facts. */
	pHuman: number;
	human: MoveFacts | null;
	humanMove: string;
	/** The bot's expectations under `q`. */
	bot: MoveFacts;
	topQ: string | undefined;
	topP: string | undefined;
	hasMate: boolean;
	hasPrev: boolean;
}

/** Loss facts of one move (for the human) or `q`-expectations of them (for the bot). */
interface MoveFacts {
	lossCp: number;
	inaccuracy: number;
	mistake: number;
	blunder: number;
	hang: number;
	mate: number;
	samePiece: number;
}

const LICHESS_DROPS = { inaccuracy: 0.1, mistake: 0.2, blunder: 0.3 } as const;

function replayRow(
	row: CorpusRow,
	id: string,
	frame: FrameRecord,
	policy: PolicyResult | null,
	draws: number,
	seed: string
): RowResult {
	const ranked = rankedLines(frame.lines);
	const top = ranked[0];
	if (!top) throw new Error(`${id}: the frame has no scored line`);
	const topCp = cpEffective(top.score);
	const winTop = winProb(topCp);
	const byUci = new Map<string, EvalLine>();
	for (const line of ranked) byUci.set(line.pvUci[0] ?? "", line);
	const prevTo = row.prevOwnMove === undefined ? undefined : parseUci(row.prevOwnMove)?.to;
	const facts = (line: EvalLine, uci: string): MoveFacts => {
		const cp = cpEffective(line.score);
		const drop = winTop - winProb(cp);
		return {
			lossCp: Math.max(0, topCp - cp),
			inaccuracy: drop >= LICHESS_DROPS.inaccuracy ? 1 : 0,
			mistake: drop >= LICHESS_DROPS.mistake ? 1 : 0,
			blunder: drop >= LICHESS_DROPS.blunder ? 1 : 0,
			hang: hangsPiece(line, drop, row.fen) ? 1 : 0,
			mate: (line.score.mate ?? 0) > 0 ? 1 : 0,
			samePiece: prevTo !== undefined && parseUci(uci)?.from === prevTo ? 1 : 0,
		};
	};

	const parts = parseFen(row.fen);
	const ply = row.ply ?? (parts ? plyOf(parts) : 0);
	const legal = legalMoves(row.fen);
	const base: Omit<SelectionContext, "rng" | "state"> = {
		fen: row.fen,
		targetElo: row.selfElo,
		form: 0,
		ply,
		phase: phaseOf(row.fen, ply) ?? "middlegame",
		myClockMs: row.clockMs,
		oppClockMs: row.oppClockMs ?? row.clockMs,
		selectionMode: "hybrid",
		blunderScale: 1,
		...(row.baseMs === undefined ? {} : { baseMs: row.baseMs }),
		...(row.incrementMs === undefined ? {} : { incrementMs: row.incrementMs }),
		...(row.lastMove === undefined ? {} : { lastMove: row.lastMove }),
		...(frame.bestmove === null ? {} : { engineBestmove: frame.bestmove }),
		...(policy === null ? {} : { maia: policy, maiaExtra: frame.extra }),
	};
	const prior = heuristicPrior(row.fen, frame.lines, { ...base, state: createSelectionState() });
	const rng = createRng(`${seed}:${id}`);
	const counts = new Map<string, number>();
	const sources = new Map<ChosenMove["source"], number>();
	const meters = { kl: 0, railed: 0, unscored: 0, n: 0 };
	for (let i = 0; i < draws; i++) {
		const m = selectMove(frame.lines, { ...base, rng, state: createSelectionState() }, prior);
		counts.set(m.uci, (counts.get(m.uci) ?? 0) + 1);
		sources.set(m.source, (sources.get(m.source) ?? 0) + 1);
		if (m.maiaMeters) {
			meters.n++;
			meters.kl += m.maiaMeters.klFromMaia;
			meters.railed += m.maiaMeters.railedMass;
			meters.unscored += m.maiaMeters.unscoredMass;
		}
	}
	const q = new Map<string, number>();
	for (const [uci, n] of counts) q.set(uci, n / draws);
	const bot: MoveFacts = {
		lossCp: 0,
		inaccuracy: 0,
		mistake: 0,
		blunder: 0,
		hang: 0,
		mate: 0,
		samePiece: 0,
	};
	for (const [uci, weight] of q) {
		const line = byUci.get(uci);
		if (!line) continue;
		const f = facts(line, uci);
		for (const key of Object.keys(bot) as Array<keyof MoveFacts>) bot[key] += weight * f[key];
	}
	const humanLine = byUci.get(row.humanMove) ?? frame.humanLine;
	const pHuman = policy?.moves.find(([uci]) => uci === row.humanMove)?.[1] ?? 0;
	let topQ: string | undefined;
	let topQn = -1;
	for (const [uci, n] of counts)
		if (n > topQn) {
			topQ = uci;
			topQn = n;
		}
	return {
		id,
		gameId: row.gameId,
		ply,
		bucket: row.bucket ?? bucketOf(row.selfElo),
		legal: legal.length,
		q,
		sources,
		meters,
		humanScored: byUci.has(row.humanMove),
		pHuman,
		human: humanLine ? facts(humanLine, row.humanMove) : null,
		humanMove: row.humanMove,
		bot,
		topQ,
		topP: policy?.moves[0]?.[0],
		hasMate: ranked.some((l) => (l.score.mate ?? 0) > 0),
		hasPrev: prevTo !== undefined,
	};
}

// ── aggregation ───────────────────────────────────────────────────────────────────────────────

class Mean {
	sum = 0;
	n = 0;
	add(v: number): void {
		this.sum += v;
		this.n++;
	}
	get value(): number | null {
		return this.n === 0 ? null : this.sum / this.n;
	}
}

function pearson(pairs: Array<[number, number]>): number | null {
	if (pairs.length < 3) return null;
	let mx = 0;
	let my = 0;
	for (const [x, y] of pairs) {
		mx += x;
		my += y;
	}
	mx /= pairs.length;
	my /= pairs.length;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (const [x, y] of pairs) {
		sxy += (x - mx) * (y - my);
		sxx += (x - mx) ** 2;
		syy += (y - my) ** 2;
	}
	return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export interface BucketReport {
	bucket: number;
	n: number;
	humanScored: number;
	logQ: number | null;
	logP: number | null;
	top1Q: number | null;
	top1P: number | null;
	expQ: number | null;
	expP: number | null;
	bot: Record<keyof MoveFacts, number | null> & { lag1: number | null };
	human: Record<keyof MoveFacts, number | null> & { lag1: number | null };
	meters: {
		kl: number | null;
		railed: number | null;
		unscored: number | null;
		maiaShare: number | null;
	};
}

function aggregate(results: RowResult[], draws: number): BucketReport[] {
	const out: BucketReport[] = [];
	for (const bucket of BUCKETS) {
		const rows = results.filter((r) => r.bucket === bucket);
		if (rows.length === 0) continue;
		const m = {
			logQ: new Mean(),
			logP: new Mean(),
			top1Q: new Mean(),
			top1P: new Mean(),
			expQ: new Mean(),
			expP: new Mean(),
			scored: new Mean(),
			kl: new Mean(),
			railed: new Mean(),
			unscored: new Mean(),
			maiaShare: new Mean(),
		};
		const keys: Array<keyof MoveFacts> = [
			"lossCp",
			"inaccuracy",
			"mistake",
			"blunder",
			"hang",
			"mate",
			"samePiece",
		];
		const bot = Object.fromEntries(keys.map((k) => [k, new Mean()])) as Record<keyof MoveFacts, Mean>;
		const human = Object.fromEntries(keys.map((k) => [k, new Mean()])) as Record<
			keyof MoveFacts,
			Mean
		>;
		for (const r of rows) {
			const qh = r.q.get(r.humanMove) ?? 0;
			// Add-half smoothing over the legal moves keeps log q finite for an undrawn human move.
			m.logQ.add(Math.log((qh * draws + 0.5) / (draws + 0.5 * r.legal)));
			m.logP.add(Math.log(Math.max(r.pHuman, 1e-9)));
			m.top1Q.add(r.topQ === r.humanMove ? 1 : 0);
			m.top1P.add(r.topP === r.humanMove ? 1 : 0);
			m.expQ.add(qh);
			m.expP.add(r.pHuman);
			m.scored.add(r.humanScored ? 1 : 0);
			if (r.meters.n > 0) {
				m.kl.add(r.meters.kl / r.meters.n);
				m.railed.add(r.meters.railed / r.meters.n);
				m.unscored.add(r.meters.unscored / r.meters.n);
			}
			m.maiaShare.add((r.sources.get("maia") ?? 0) / draws);
			for (const k of keys) {
				if (k === "mate" && !r.hasMate) continue;
				if (k === "samePiece" && !r.hasPrev) continue;
				bot[k].add(r.bot[k]);
				if (r.human) human[k].add(r.human[k]);
			}
		}
		// Lag-1 autocorrelation of loss along each game's own-move sequence.
		const byGame = new Map<string, RowResult[]>();
		for (const r of rows) {
			const key = r.gameId ?? r.id;
			const list = byGame.get(key) ?? [];
			list.push(r);
			byGame.set(key, list);
		}
		const botPairs: Array<[number, number]> = [];
		const humanPairs: Array<[number, number]> = [];
		for (const list of byGame.values()) {
			list.sort((a, b) => a.ply - b.ply);
			for (let i = 1; i < list.length; i++) {
				const a = list[i - 1]!;
				const b = list[i]!;
				botPairs.push([a.bot.lossCp, b.bot.lossCp]);
				if (a.human && b.human) humanPairs.push([a.human.lossCp, b.human.lossCp]);
			}
		}
		const facts = (src: Record<keyof MoveFacts, Mean>, lag1: number | null) =>
			Object.assign(
				Object.fromEntries(keys.map((k) => [k, src[k].value])) as Record<
					keyof MoveFacts,
					number | null
				>,
				{ lag1 }
			);
		out.push({
			bucket,
			n: rows.length,
			humanScored: m.scored.value ?? 0,
			logQ: m.logQ.value,
			logP: m.logP.value,
			top1Q: m.top1Q.value,
			top1P: m.top1P.value,
			expQ: m.expQ.value,
			expP: m.expP.value,
			bot: facts(bot, pearson(botPairs)),
			human: facts(human, pearson(humanPairs)),
			meters: {
				kl: m.kl.value,
				railed: m.railed.value,
				unscored: m.unscored.value,
				maiaShare: m.maiaShare.value,
			},
		});
	}
	return out;
}

// ── report ────────────────────────────────────────────────────────────────────────────────────

function fmt(v: number | null, digits = 3, scale = 1): string {
	return v === null ? "—" : (v * scale).toFixed(digits);
}

export function markdown(reports: BucketReport[], header: string[]): string {
	const cols = reports.map((r) => `${r.bucket}`);
	const rows: Array<[string, (r: BucketReport) => string]> = [
		["positions", (r) => `${r.n}`],
		["human move scored by the pool", (r) => fmt(r.humanScored, 1, 100)],
		["E[log q(m_human)]  (wrapper)", (r) => fmt(r.logQ)],
		["E[log p(m_human)]  (raw Maia)", (r) => fmt(r.logP)],
		["top-1 agreement q %", (r) => fmt(r.top1Q, 1, 100)],
		["top-1 agreement p %", (r) => fmt(r.top1P, 1, 100)],
		["E[q(m_human)]", (r) => fmt(r.expQ)],
		["E[p(m_human)]", (r) => fmt(r.expP)],
		["ACPL bot / human", (r) => `${fmt(r.bot.lossCp, 1)} / ${fmt(r.human.lossCp, 1)}`],
		[
			"inaccuracy % bot / human",
			(r) => `${fmt(r.bot.inaccuracy, 1, 100)} / ${fmt(r.human.inaccuracy, 1, 100)}`,
		],
		[
			"mistake % bot / human",
			(r) => `${fmt(r.bot.mistake, 1, 100)} / ${fmt(r.human.mistake, 1, 100)}`,
		],
		[
			"blunder % bot / human",
			(r) => `${fmt(r.bot.blunder, 1, 100)} / ${fmt(r.human.blunder, 1, 100)}`,
		],
		[
			"piece hangs per 40 moves bot / human",
			(r) => `${fmt(r.bot.hang, 2, 40)} / ${fmt(r.human.hang, 2, 40)}`,
		],
		["mate found % bot / human", (r) => `${fmt(r.bot.mate, 1, 100)} / ${fmt(r.human.mate, 1, 100)}`],
		[
			"same piece as last move % bot / human",
			(r) => `${fmt(r.bot.samePiece, 1, 100)} / ${fmt(r.human.samePiece, 1, 100)}`,
		],
		["lag-1 loss autocorrelation bot / human", (r) => `${fmt(r.bot.lag1)} / ${fmt(r.human.lag1)}`],
		["Maia share of draws %", (r) => fmt(r.meters.maiaShare, 1, 100)],
		["mean KL(draw ‖ Maia)", (r) => fmt(r.meters.kl, 4)],
		["mean railed mass", (r) => fmt(r.meters.railed)],
		["mean unscored mass", (r) => fmt(r.meters.unscored)],
	];
	const lines = [
		"# Human move-match replay",
		"",
		...header.map((h) => `- ${h}`),
		"",
		`| metric | ${cols.join(" | ")} |`,
		`|---|${cols.map(() => "---:").join("|")}|`,
		...rows.map(([name, cell]) => `| ${name} | ${reports.map(cell).join(" | ")} |`),
		"",
	];
	return lines.join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const started = performance.now();
	let rows: CorpusRow[];
	const frames = new Map<string, FrameRecord>();
	const policies = new Map<string, PolicyResult>();
	const header: string[] = [];

	if (args.fixture) {
		const size: FixturePolicyKey = args.size ?? FIXTURE_DEFAULT_KEY;
		const f = await fixtureCorpus(size, args.seed, args.limit);
		rows = f.rows;
		for (const [k, v] of f.frames) frames.set(k, v);
		for (const [k, v] of f.policies) policies.set(k, v);
		header.push(
			`**Smoke run on test/fixtures/strength/maia-draw.json** (${size}): the "human" move of every position is one seeded draw from Maia's own distribution — the numbers exercise the harness and mean nothing.`
		);
	} else {
		rows = await readCorpus(args.corpus as string, args.limit);
		header.push(`corpus \`${args.corpus}\` (${rows.length} positions)`);
		if (args.frames) {
			const stored = (await Bun.file(args.frames).json()) as Record<string, FrameRecord>;
			for (const [k, v] of Object.entries(stored)) frames.set(k, v);
			header.push(`frames \`${args.frames}\``);
		}
		if (args.policies) {
			const stored = (await Bun.file(args.policies).json()) as Record<string, PolicyResult>;
			for (const [k, v] of Object.entries(stored)) policies.set(k, v);
			header.push(`policies \`${args.policies}\``);
		}
	}

	let maia: MaiaRunner | undefined;
	if (args.maia) {
		maia = await createMaiaRunner(1);
		header.push(`Maia: shipped ONNX (${args.size ?? "size by maiaSizeFor(selfElo)"})`);
	}
	let engine: RefereeEngine | undefined;
	if (args.engine) {
		engine = await createRefereeEngine({ threads: 1, hashMb: 32 });
		header.push(
			`referee: vendored Stockfish 19 smallnet, movetime ${args.movetime} ms, depth cap automaticDepthForElo(selfElo), MultiPV by selectionCandidates, extra searchmoves ${MAIA.extraSearchMs} ms`
		);
	}
	header.push(`draws per position: ${args.draws}; seed \`${args.seed}\``);

	const results: RowResult[] = [];
	for (const [index, row] of rows.entries()) {
		const id = rowId(row, index);
		let policy = policies.get(id) ?? null;
		if (policy === null && maia) {
			const size = args.size ?? maiaSizeFor(row.selfElo);
			policy = await maia.query(size, row.historyFens, row.selfElo, row.oppoElo);
			policies.set(id, policy);
		}
		let frame = frames.get(id);
		if (!frame && engine) {
			frame = await refereeFrame(engine, row, policy, args.movetime);
			frames.set(id, frame);
		}
		if (!frame) throw new Error(`${id}: no referee frame (pass --frames FILE or --engine)`);
		const result = replayRow(row, id, frame, policy, args.draws, args.seed);
		results.push(result);
		if ((index + 1) % 25 === 0 || index + 1 === rows.length)
			console.log(
				`${index + 1}/${rows.length} positions (${((performance.now() - started) / 1000).toFixed(0)} s)`
			);
	}
	engine?.dispose();
	await maia?.dispose();

	if (args.framesOut) {
		await Bun.write(args.framesOut, `${JSON.stringify(Object.fromEntries(frames))}\n`);
		console.log(`wrote ${args.framesOut}`);
	}
	if (args.policiesOut) {
		await Bun.write(args.policiesOut, `${JSON.stringify(Object.fromEntries(policies))}\n`);
		console.log(`wrote ${args.policiesOut}`);
	}

	const reports = aggregate(results, args.draws);
	const md = markdown(reports, header);
	if (args.out) {
		await Bun.write(args.out, md);
		console.log(`wrote ${args.out}`);
	} else console.log(md);
	if (args.json) {
		await Bun.write(
			args.json,
			`${JSON.stringify({ header, draws: args.draws, seed: args.seed, buckets: reports }, null, 1)}\n`
		);
		console.log(`wrote ${args.json}`);
	}
	console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (import.meta.main) await main();
