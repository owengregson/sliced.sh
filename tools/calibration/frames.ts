/**
 * tools/calibration/frames.ts — the referee (Stockfish) frame cache for the offline Maia
 * strength-calibration harness. Library + CLI.
 *
 * One JSON object per corpus row id in `data/calibration/frames.jsonl` (`FrameCacheRecord`),
 * searched the way `tools/human-match/replay.ts`'s `refereeFrame` mirrors the pipeline — the
 * vendored Stockfish 19 smallnet, one thread, 32 MB hash, `ucinewgame` before every search:
 *
 *   1. main MultiPV search: `go movetime SEARCH_BUDGET.moveMs[tc] depth automaticDepthForElo(bucket)`,
 *      MultiPV `breadthFor(bucket, legal)`; the same search also captures, for every depth d of
 *      the `HUMAN_DEPTH` range (2…14), the first complete MultiPV cycle at depth ≥ d — the rule
 *      `uci-client.ts` applies to the pipeline's human-depth frame (`analysis.atFeatureDepth`) —
 *      so the harness can read the frame for whatever Maia rating it conditions on;
 *   2. one extra `searchmoves` pass on Maia's favourites the main frame left unscored, pooled over
 *      **every** grid policy of the row (each policy gated by `maiaExtraSearchmoves`, up to
 *      `EXTRA_MAX_ROOTS` roots), merged with `mergeLines`;
 *   3. the human move's own single-root line when the pool still lacks it (`humanLine`, never in
 *      the pool).
 *
 * Usage
 *   bun tools/calibration/frames.ts [--corpus data/calibration/corpus.jsonl]
 *        [--policies data/calibration/policies.jsonl | --no-policies] [--require-policies]
 *        [--out data/calibration/frames.jsonl]
 *        [--workers 9] [--limit N] [--filter-split fit|holdout] [--filter-tc bullet,blitz]
 *        [--sample-per-cell K] [--seed S]
 *
 * Resumable: ids already in `--out` or in its `.parts/` directory are skipped; parts are merged
 * into `--out` at the end (and at the start of the next run, should one be interrupted).
 */

import "../lib/defines";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { legalMoves } from "@core/chess/san";
import { MAIA } from "@core/constants/maia";
import { HUMAN_DEPTH, SEARCH_BUDGET } from "@core/constants/search";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { PolicyResult } from "@core/policy/types";
import { maiaUnscoredMoves, mergeLines } from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import type { CorpusRow } from "../human-match/replay";
import { createRefereeEngine } from "../lib/engine/referee";
import type { CapturedCycle, RefereeEngine } from "../lib/engine/types";
import { ROOT } from "../lib/paths";

// ── schema ────────────────────────────────────────────────────────────────────────────────────

export type TcClass = "bullet" | "blitz" | "rapid";

/** A `data/calibration/corpus.jsonl` row: replay.ts's `CorpusRow` plus the calibration keys. */
export interface CalibrationRow extends CorpusRow {
	tc: TcClass;
	/** chess.com rating bucket, 600…3000 step 200. */
	bucket: number;
	player?: string;
	color?: "w" | "b" | "white" | "black";
	split?: "fit" | "holdout";
}

/** One grid entry of `data/calibration/policies.jsonl`. */
export interface GridPolicy {
	selfElo: number;
	moves: Array<[string, number]>;
	wdl?: [number, number, number];
}

export interface PolicyRecord {
	id: string;
	policies: GridPolicy[];
}

export interface ScoredRoot {
	uci: string;
	score: EvalLine["score"];
}

export interface FrameCacheRecord {
	id: string;
	/**
	 * The merged scored pool: the main frame sorted by `compareLines`, then the extra pass's new
	 * roots (sorted by `compareLines` among themselves) — `mergeLines`'s order, which `rankedLines`
	 * relies on to pin the main frame's best line as the reference. `multipv` is renumbered 1…K.
	 */
	lines: EvalLine[];
	bestmove: string | null;
	/** Roots the extra `searchmoves` pass added to `lines`. */
	extra: string[];
	/** Depth of the main frame. */
	depth: number;
	/** Whether the main frame reported every requested root at `depth`. */
	complete: boolean;
	/**
	 * Requested depth d (2…14) → the first complete main-search cycle at depth ≥ d, roots in the
	 * engine's order. A depth the search never completed a cycle at or past is absent.
	 */
	byDepth: Record<number, ScoredRoot[]>;
	/** Requested depth d → the depth that cycle was actually reported at (≥ d). */
	byDepthAt: Record<number, number>;
	/** The human move's own line when the pool never scored it (baseline only, not in `lines`). */
	humanLine?: EvalLine;
	/** Wall-clock ms the row's searches took. */
	ms: number;
}

// ── recipe ────────────────────────────────────────────────────────────────────────────────────

/** `HUMAN_DEPTH`'s range, every integer depth — the human frame for any Maia rating. */
export const CAPTURE_DEPTHS: readonly number[] = (() => {
	const ds = HUMAN_DEPTH.map(([, d]) => d);
	const lo = Math.min(...ds);
	const hi = Math.max(...ds);
	return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
})();

/** The extra pass scores at most this many roots (production: `MAIA.extraCandidates` from one policy). */
export const EXTRA_MAX_ROOTS = 10;

export const MAIN_MOVETIME_MS: Readonly<Record<TcClass, number>> = {
	bullet: SEARCH_BUDGET.moveMs.bullet,
	blitz: SEARCH_BUDGET.moveMs.blitz,
	rapid: SEARCH_BUDGET.moveMs.rapid,
};

/** Referee breadth for a target, as `searchBudget` sizes it for Maia mode (replay.ts's copy). */
export function breadthFor(targetElo: number, legal: number): number {
	const band = SEARCH_BUDGET.selectionCandidates.find((b) => targetElo <= b.maxElo)?.count ?? 0;
	const wanted = Math.max(SEARCH_BUDGET.multiPvMedium, band);
	return legal > 0 ? Math.min(wanted, legal) : wanted;
}

export function rowId(row: CorpusRow, index: number): string {
	return row.id ?? (row.gameId !== undefined ? `${row.gameId}:${row.ply}` : `row:${index}`);
}

function asPolicy(g: GridPolicy): PolicyResult {
	return { moves: g.moves, wdl: g.wdl ?? [0, 1, 0], size: MAIA.defaultSize };
}

/**
 * The extra pass's roots, pooled over the grid. Each policy contributes what
 * `maiaExtraSearchmoves` would search for it (its unscored moves at `p ≥ MAIA.minProb`, gated by
 * `extraMassMin` / `extraTopProb`, its top `extraCandidates`); the union is ordered by the best
 * rank any policy gives a move, then by its highest probability, so every grid rating's first
 * favourites are covered before anyone's sixth. At most `EXTRA_MAX_ROOTS`.
 */
export function gridExtraSearchmoves(
	policies: readonly GridPolicy[],
	lines: readonly EvalLine[],
	fen: string,
	max = EXTRA_MAX_ROOTS
): string[] {
	const best = new Map<string, { rank: number; p: number }>();
	for (const g of policies) {
		const unscored = maiaUnscoredMoves(asPolicy(g), lines, fen);
		let mass = 0;
		for (const [, p] of unscored) mass += p;
		const top = unscored[0]?.[1] ?? 0;
		if (mass < MAIA.extraMassMin && top < MAIA.extraTopProb) continue;
		unscored.slice(0, MAIA.extraCandidates).forEach(([uci, p], rank) => {
			const held = best.get(uci);
			if (!held) best.set(uci, { rank, p });
			else best.set(uci, { rank: Math.min(rank, held.rank), p: Math.max(p, held.p) });
		});
	}
	return [...best]
		.sort((a, b) => a[1].rank - b[1].rank || b[1].p - a[1].p || (a[0] < b[0] ? -1 : 1))
		.slice(0, max)
		.map(([uci]) => uci);
}

function roots(cycle: CapturedCycle): ScoredRoot[] {
	return cycle.lines.map((l) => ({ uci: l.uci, score: l.score }));
}

/** The three searches of one row. `policies` may be empty (no extra pass). */
export async function computeFrame(
	engine: RefereeEngine,
	row: CalibrationRow,
	id: string,
	policies: readonly GridPolicy[]
): Promise<FrameCacheRecord> {
	const started = performance.now();
	const legal = legalMoves(row.fen);
	const target = row.bucket ?? row.selfElo;
	const movetimeMs = MAIN_MOVETIME_MS[row.tc] ?? SEARCH_BUDGET.moveMs.blitz;
	const depthCap = automaticDepthForElo(target);
	const main = await engine.search({
		fen: row.fen,
		movetimeMs,
		depth: depthCap,
		multiPv: breadthFor(target, legal.length),
		captureDepths: CAPTURE_DEPTHS,
		strictCycles: true,
	});
	let lines = main.lines;
	const extra: string[] = [];
	const searchmoves = gridExtraSearchmoves(policies, lines, row.fen);
	if (searchmoves.length > 0) {
		const pass = await engine.search({
			fen: row.fen,
			movetimeMs: Math.max(SEARCH_BUDGET.minMovetimeMs, Math.min(MAIA.extraSearchMs, movetimeMs)),
			multiPv: searchmoves.length,
			searchmoves,
			strictCycles: true,
		});
		const mainCount = lines.length;
		lines = mergeLines(lines, pass.lines);
		for (const line of lines.slice(mainCount))
			if (line.pvUci[0] !== undefined) extra.push(line.pvUci[0]);
	}
	const byDepth: Record<number, ScoredRoot[]> = {};
	const byDepthAt: Record<number, number> = {};
	for (const d of CAPTURE_DEPTHS) {
		const cycle = main.byDepth?.[d];
		if (!cycle) continue;
		byDepth[d] = roots(cycle);
		byDepthAt[d] = cycle.depth;
	}
	const record: FrameCacheRecord = {
		id,
		lines,
		bestmove: main.bestmove,
		extra,
		depth: main.depth,
		complete: main.complete,
		byDepth,
		byDepthAt,
		ms: 0,
	};
	if (legal.includes(row.humanMove) && !lines.some((l) => l.pvUci[0] === row.humanMove)) {
		const own = await engine.search({
			fen: row.fen,
			movetimeMs,
			depth: depthCap,
			multiPv: 1,
			searchmoves: [row.humanMove],
			strictCycles: true,
		});
		const line = own.lines[0];
		if (line) record.humanLine = line;
	}
	record.ms = Math.round(performance.now() - started);
	return record;
}

export async function createFrameEngine(): Promise<RefereeEngine> {
	return createRefereeEngine({ threads: 1, hashMb: 32, timeoutMs: 15_000 });
}

// ── I/O helpers ───────────────────────────────────────────────────────────────────────────────

/** Line-by-line over a (possibly large) JSONL file without holding it as one string. */
export async function* jsonlLines(file: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = Bun.file(file).stream().getReader();
	let rest = "";
	for (;;) {
		const { done, value } = await reader.read();
		rest += done ? decoder.decode() : decoder.decode(value, { stream: true });
		let start = 0;
		let nl = rest.indexOf("\n", start);
		while (nl >= 0) {
			const line = rest.slice(start, nl).trim();
			if (line) yield line;
			start = nl + 1;
			nl = rest.indexOf("\n", start);
		}
		rest = rest.slice(start);
		if (done) break;
	}
	if (rest.trim()) yield rest.trim();
}

/** Ids already written to a frames JSONL (tolerates a torn last line). */
async function idsIn(file: string, into: Set<string>): Promise<void> {
	if (!existsSync(file)) return;
	for await (const line of jsonlLines(file)) {
		const m = /^\{"id":("(?:[^"\\]|\\.)*")/.exec(line);
		if (m?.[1]) into.add(JSON.parse(m[1]) as string);
	}
}

/** FNV-1a, 32 bit — the deterministic per-cell subsample order. */
export function hash32(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

// ── worker ────────────────────────────────────────────────────────────────────────────────────

interface Task {
	type: "task";
	id: string;
	row: CalibrationRow;
	policies: GridPolicy[];
}

type WorkerMessage =
	| { type: "ready" }
	| { type: "done"; id: string; ms: number }
	| { type: "failed"; id: string; error: string };

async function runWorker(partFile: string): Promise<void> {
	const send = (m: WorkerMessage): void => {
		process.send?.(m);
	};
	let engine = await createFrameEngine();
	const restart = async (): Promise<void> => {
		engine.dispose();
		engine = await createFrameEngine();
	};
	let queue = Promise.resolve();
	// An orphaned worker (the coordinator killed) stops instead of idling on a dead channel.
	process.on("disconnect", () => {
		engine.dispose();
		process.exit(0);
	});
	process.on("message", (raw: unknown) => {
		const msg = raw as Task | { type: "exit" };
		if (msg.type === "exit") {
			queue = queue.then(() => {
				engine.dispose();
				process.exit(0);
			});
			return;
		}
		queue = queue.then(async () => {
			let lastError = "";
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const record = await computeFrame(engine, msg.row, msg.id, msg.policies);
					await appendFile(partFile, `${JSON.stringify(record)}\n`);
					send({ type: "done", id: msg.id, ms: record.ms });
					return;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					await restart().catch((e: unknown) => {
						lastError += ` | restart failed: ${String(e)}`;
					});
				}
			}
			send({ type: "failed", id: msg.id, error: lastError });
		});
	});
	send({ type: "ready" });
}

/** Workers that die before their first message; past this many the run stops respawning. */
const MAX_STARTUP_FAILURES = 3;

// ── coordinator ───────────────────────────────────────────────────────────────────────────────

interface Args {
	corpus: string;
	policies?: string;
	out: string;
	workers: number;
	limit: number;
	filterSplit?: string;
	filterTc?: Set<string>;
	samplePerCell: number;
	seed: string;
	worker?: string;
	/** Search only rows whose policies are already written (a run alongside `maia-batch.ts`). */
	requirePolicies?: boolean;
}

function parseArgs(argv: string[]): Args {
	const dataDir = path.join(ROOT, "data/calibration");
	const args: Args = {
		corpus: path.join(dataDir, "corpus.jsonl"),
		policies: path.join(dataDir, "policies.jsonl"),
		out: path.join(dataDir, "frames.jsonl"),
		workers: 9,
		limit: 0,
		samplePerCell: 0,
		seed: "frames",
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
			case "--policies":
				args.policies = take(i++);
				break;
			case "--require-policies":
				args.requirePolicies = true;
				break;
			case "--no-policies":
				delete args.policies;
				break;
			case "--out":
				args.out = take(i++);
				break;
			case "--workers":
				args.workers = Math.max(1, Number(take(i++)));
				break;
			case "--limit":
				args.limit = Number(take(i++));
				break;
			case "--filter-split":
				args.filterSplit = take(i++);
				break;
			case "--filter-tc":
				args.filterTc = new Set(take(i++).split(","));
				break;
			case "--sample-per-cell":
				args.samplePerCell = Number(take(i++));
				break;
			case "--seed":
				args.seed = take(i++);
				break;
			case "--worker":
				args.worker = take(i++);
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	return args;
}

async function selectRows(args: Args): Promise<Array<{ id: string; row: CalibrationRow }>> {
	let rows: Array<{ id: string; row: CalibrationRow }> = [];
	let index = 0;
	for await (const line of jsonlLines(args.corpus)) {
		const row = JSON.parse(line) as CalibrationRow;
		const id = rowId(row, index++);
		if (args.filterSplit !== undefined && row.split !== args.filterSplit) continue;
		if (args.filterTc !== undefined && !args.filterTc.has(row.tc)) continue;
		rows.push({ id, row });
	}
	if (args.samplePerCell > 0) {
		const cells = new Map<string, Array<{ id: string; row: CalibrationRow }>>();
		for (const r of rows) {
			const key = `${r.row.tc}:${r.row.bucket}`;
			const list = cells.get(key) ?? [];
			list.push(r);
			cells.set(key, list);
		}
		rows = [];
		for (const list of cells.values()) {
			list.sort(
				(a, b) =>
					hash32(`${args.seed}:${a.id}`) - hash32(`${args.seed}:${b.id}`) || (a.id < b.id ? -1 : 1)
			);
			rows.push(...list.slice(0, args.samplePerCell));
		}
	}
	if (args.limit > 0) rows = rows.slice(0, args.limit);
	return rows;
}

async function loadPolicies(
	file: string | undefined,
	want: Set<string>
): Promise<Map<string, GridPolicy[]>> {
	const out = new Map<string, GridPolicy[]>();
	if (file === undefined || !existsSync(file)) return out;
	for await (const line of jsonlLines(file)) {
		const m = /^\{"id":("(?:[^"\\]|\\.)*")/.exec(line);
		// Cheap pre-filter by a leading id; fall back to a full parse for other key orders.
		if (m?.[1] && !want.has(JSON.parse(m[1]) as string)) continue;
		const rec = JSON.parse(line) as PolicyRecord;
		if (want.has(rec.id)) out.set(rec.id, rec.policies);
	}
	return out;
}

/** Append every part record whose id `out` lacks, then drop the parts directory. */
async function mergeParts(out: string, partsDir: string): Promise<number> {
	if (!existsSync(partsDir)) return 0;
	const have = new Set<string>();
	await idsIn(out, have);
	let added = 0;
	for (const name of readdirSync(partsDir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const chunk: string[] = [];
		for await (const line of jsonlLines(path.join(partsDir, name))) {
			let rec: FrameCacheRecord;
			try {
				rec = JSON.parse(line) as FrameCacheRecord;
			} catch {
				continue; // a torn last line from an interrupted worker
			}
			if (have.has(rec.id)) continue;
			have.add(rec.id);
			chunk.push(line);
			added++;
		}
		if (chunk.length > 0) await appendFile(out, `${chunk.join("\n")}\n`);
	}
	rmSync(partsDir, { recursive: true, force: true });
	return added;
}

function fmtDuration(s: number): string {
	if (!Number.isFinite(s)) return "?";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0
		? `${h}h${String(m).padStart(2, "0")}m`
		: `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

async function runCoordinator(args: Args): Promise<void> {
	const started = performance.now();
	mkdirSync(path.dirname(args.out), { recursive: true });
	const partsDir = `${args.out}.parts`;
	const recovered = await mergeParts(args.out, partsDir);
	if (recovered > 0) console.log(`merged ${recovered} records left by an interrupted run`);
	const done = new Set<string>();
	await idsIn(args.out, done);
	const selected = await selectRows(args);
	const todo = selected.filter((r) => !done.has(r.id));
	console.log(
		`${selected.length} rows selected, ${selected.length - todo.length} already cached, ${todo.length} to search`
	);
	if (todo.length === 0) return;
	const policies = await loadPolicies(args.policies, new Set(todo.map((r) => r.id)));
	if (args.requirePolicies) {
		const ready = todo.filter((r) => policies.has(r.id));
		console.log(`--require-policies: ${ready.length}/${todo.length} rows have their policies`);
		todo.splice(0, todo.length, ...ready);
		if (todo.length === 0) return;
	}
	console.log(
		args.policies && existsSync(args.policies)
			? `policies for ${policies.size}/${todo.length} rows`
			: "no policies: the extra searchmoves pass is skipped"
	);
	mkdirSync(partsDir, { recursive: true });

	const queue = todo.map((r) => ({ ...r, attempts: 0 }));
	const perTc = new Map<string, { n: number; ms: number }>();
	let finished = 0;
	let failed = 0;
	let lastReport = 0;
	const total = todo.length;
	const report = (force = false): void => {
		const now = performance.now();
		if (!force && now - lastReport < 5_000) return;
		lastReport = now;
		const secs = (now - started) / 1000;
		const rate = finished / secs;
		console.log(
			`${finished}/${total} rows (${failed} failed) · ${rate.toFixed(2)} rows/s · ETA ${fmtDuration((total - finished) / rate)}`
		);
	};
	const tcOf = new Map(todo.map((r) => [r.id, r.row.tc]));

	const workerCount = Math.min(args.workers, total);
	let startupFailures = 0;
	let nextWorker = 0;
	const spawnWorker = (): Promise<void> =>
		new Promise((resolve) => {
			const index = nextWorker++;
			const partFile = path.join(partsDir, `part-${String(index).padStart(3, "0")}.jsonl`);
			let current: (typeof queue)[number] | undefined;
			let exiting = false;
			let ready = false;
			const feed = (): void => {
				current = queue.shift();
				if (current === undefined) {
					exiting = true;
					child.send({ type: "exit" });
					return;
				}
				child.send({
					type: "task",
					id: current.id,
					row: current.row,
					policies: policies.get(current.id) ?? [],
				} satisfies Task);
			};
			const child = Bun.spawn([process.execPath, import.meta.path, "--worker", partFile], {
				cwd: ROOT,
				stdout: "inherit",
				stderr: "inherit",
				serialization: "json",
				ipc(raw) {
					const msg = raw as WorkerMessage;
					ready = true;
					if (msg.type === "done") {
						finished++;
						const tc = tcOf.get(msg.id) ?? "?";
						const agg = perTc.get(tc) ?? { n: 0, ms: 0 };
						agg.n++;
						agg.ms += msg.ms;
						perTc.set(tc, agg);
						report();
					} else if (msg.type === "failed") {
						finished++;
						failed++;
						console.error(`skip ${msg.id}: ${msg.error}`);
					}
					feed();
				},
			});
			void child.exited.then(async (code) => {
				if (!exiting) {
					// Crashed mid-row: retry that row once elsewhere, then respawn if work remains.
					console.error(`worker ${index} exited (${code}) during ${current?.id ?? "startup"}`);
					if (current) {
						current.attempts++;
						if (current.attempts <= 1) queue.push(current);
						else {
							finished++;
							failed++;
							console.error(`skip ${current.id}: worker crashed twice`);
						}
					}
					if (!ready) startupFailures++;
					if (queue.length > 0 && startupFailures < MAX_STARTUP_FAILURES) await spawnWorker();
				}
				resolve();
			});
		});
	await Promise.all(Array.from({ length: workerCount }, () => spawnWorker()));
	report(true);
	if (queue.length > 0)
		console.error(
			`${queue.length} rows left unsearched: workers failed to start ${startupFailures}×`
		);
	const merged = await mergeParts(args.out, partsDir);
	const wall = (performance.now() - started) / 1000;
	console.log(`merged ${merged} records into ${args.out} in ${fmtDuration(wall)}`);
	for (const [tc, agg] of [...perTc].sort()) {
		const mean = agg.ms / agg.n / 1000;
		console.log(
			`  ${tc}: ${agg.n} rows · ${mean.toFixed(2)} s/row per worker · ≈ ${(mean / workerCount).toFixed(3)} s/row at ${workerCount} workers`
		);
	}
	console.log(`  overall: ${(wall / Math.max(1, finished)).toFixed(3)} s/row wall`);
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.worker !== undefined) await runWorker(args.worker);
	else await runCoordinator(args);
}
