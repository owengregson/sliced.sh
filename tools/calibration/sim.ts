/**
 * tools/calibration/sim.ts — the bot on real human positions, the way the pipeline plays them.
 *
 * For one cell (chess.com time class × rating bucket R) the rows of each sampled (game, side) are
 * walked in ply order by `chains` independent chains. At every row a chain does what the
 * service worker does for an own move at target R:
 *
 *   1. `ownMoveMaiaElo` — the calibrated conditioning, opponent pressure and the clock/think
 *      context penalty (timing persona `tau` sampled per chain as the session samples it per game,
 *      form 0 as the session holds it) → Maia's query rating;
 *   2. Maia's answer at that rating, log-linearly interpolated between the row's cached grid
 *      policies (`PolicyGrid`);
 *   3. the human-depth frame `humanDepth(selfElo)` from the cached per-depth cycles;
 *   4. `selectMove` over the cached referee pool with the production `SelectionContext`
 *      (`hybrid`, unrestricted referee, the calibration table under test).
 *
 * The chain's per-game state follows the game that was actually played: after each draw the
 * previous-own-moves memory and the tilt trigger's reference score are set from the **human's**
 * move, because that is the move the next position came from. Every pick is judged by the same
 * referee frame as the human's move (`judge`), so bot and human numbers are paired per position.
 */

import "../lib/defines";
import { phase as phaseOf } from "@core/chess/phase";
import type { MaiaCalibrationTable } from "@core/constants/maia-calibration";
import { humanDepth } from "@core/engine/depth-policy";
import type { PolicyResult } from "@core/policy/types";
import { createRng, type Rng } from "@core/rng";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { rankedLines } from "@core/strength/quality";
import { maiaSelfElo } from "@core/strength/selection-elo";
import type { SelectionContext, SelectionState } from "@core/strength/types";
import { samplePersona } from "@core/timing/persona-latents";
import { clamp } from "@core/util/clamp";
import { ownMoveMaiaElo } from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import { DEFAULT_SETTINGS } from "@typedefs/settings";
import type { CalibrationRow, FrameCacheRecord, GridPolicy } from "./frames";

// ── Maia at any rating from the cached grid ──────────────────────────────────────────────────

/** A move a grid answer dropped (stored `p < 1e-5`) counts at this floor when interpolating. */
const MISSING_P = 1e-6;

export class PolicyGrid {
	private readonly grid: GridPolicy[];
	private readonly cache = new Map<number, PolicyResult>();

	constructor(policies: readonly GridPolicy[]) {
		this.grid = [...policies].sort((a, b) => a.selfElo - b.selfElo);
		if (this.grid.length === 0) throw new Error("PolicyGrid: no policies");
	}

	get elos(): number[] {
		return this.grid.map((g) => g.selfElo);
	}

	/** Maia's answer at `elo` (integer, as `maiaConditioningElo` rounds): clamped to the grid ends. */
	at(elo: number): PolicyResult {
		const key = Math.round(elo);
		const hit = this.cache.get(key);
		if (hit) return hit;
		const result = this.interpolate(key);
		this.cache.set(key, result);
		return result;
	}

	private interpolate(elo: number): PolicyResult {
		const g = this.grid;
		const first = g[0] as GridPolicy;
		const last = g[g.length - 1] as GridPolicy;
		let lo = first;
		let hi = first;
		if (elo >= last.selfElo) {
			lo = last;
			hi = last;
		} else if (elo > first.selfElo) {
			for (let i = 1; i < g.length; i++) {
				const next = g[i] as GridPolicy;
				if (elo <= next.selfElo) {
					lo = g[i - 1] as GridPolicy;
					hi = next;
					break;
				}
			}
		}
		const w = hi.selfElo > lo.selfElo ? (elo - lo.selfElo) / (hi.selfElo - lo.selfElo) : 0;
		const wdl = (lo.wdl ?? [1 / 3, 1 / 3, 1 / 3]).map(
			(v, i) => (1 - w) * v + w * ((hi.wdl ?? [1 / 3, 1 / 3, 1 / 3])[i] ?? v)
		) as [number, number, number];
		if (w === 0 || lo === hi) return { moves: lo.moves.map(([u, p]) => [u, p]), wdl, size: "79m" };
		const pLo = new Map(lo.moves);
		const pHi = new Map(hi.moves);
		const ucis = new Set([...pLo.keys(), ...pHi.keys()]);
		const moves: Array<[string, number]> = [];
		let sum = 0;
		for (const u of ucis) {
			const logp = (1 - w) * Math.log(pLo.get(u) ?? MISSING_P) + w * Math.log(pHi.get(u) ?? MISSING_P);
			const p = Math.exp(logp);
			moves.push([u, p]);
			sum += p;
		}
		for (const m of moves) m[1] /= sum;
		moves.sort((a, b) => b[1] - a[1]);
		return { moves, wdl, size: "79m" };
	}
}

// ── judging a move ──────────────────────────────────────────────────────────────────────────

/** How much a move gave away against the referee's best, and whether it was the best. */
export interface MoveOutcome {
	/** Win-probability loss (`winProb` on `cpEffective`), ≥ 0 — chess.com's expected-points loss. */
	winLoss: number;
	/** Centipawn loss on `cpEffective`, ≥ 0, capped at `CP_LOSS_CAP`. */
	cpLoss: number;
	/** 1 when the move is the referee's best line. */
	top1: number;
}

export const CP_LOSS_CAP = 1000;

export interface Judge {
	bestUci: string;
	topCp: number;
	/** The referee's `cpEffective` score of `uci`, when scored. */
	cpOf(uci: string): number | undefined;
	/** The outcome of `uci`, or null when the frame never scored it. */
	outcome(uci: string): MoveOutcome | null;
}

export function judgeFor(frame: FrameCacheRecord): Judge {
	const ranked = rankedLines(frame.lines);
	const top = ranked[0];
	if (!top) throw new Error(`${frame.id}: the frame has no scored line`);
	const topCp = cpEffective(top.score);
	const winTop = winProb(topCp);
	const cpOf = new Map<string, number>();
	for (const line of frame.lines) {
		const uci = line.pvUci[0];
		if (uci !== undefined && !cpOf.has(uci)) cpOf.set(uci, cpEffective(line.score));
	}
	const humanUci = frame.humanLine?.pvUci[0];
	if (frame.humanLine && humanUci !== undefined && !cpOf.has(humanUci))
		cpOf.set(humanUci, cpEffective(frame.humanLine.score));
	const bestUci = top.pvUci[0] ?? "";
	return {
		bestUci,
		topCp,
		cpOf: (uci) => cpOf.get(uci),
		outcome(uci) {
			const cp = cpOf.get(uci);
			if (cp === undefined) return null;
			return {
				winLoss: Math.max(0, winTop - winProb(cp)),
				cpLoss: Math.min(CP_LOSS_CAP, Math.max(0, topCp - cp)),
				top1: uci === bestUci ? 1 : 0,
			};
		},
	};
}

// ── one cell ─────────────────────────────────────────────────────────────────────────────────

/** A row with everything the simulation needs, as `shard.ts` writes it. */
export interface CellItem {
	row: CalibrationRow & { player?: string; split?: "fit" | "holdout" };
	frame: FrameCacheRecord;
	policies: GridPolicy[];
}

/** One (game, side): its rows in ply order and the per-row derived inputs. */
export interface Game {
	key: string;
	player: string;
	items: Array<{
		item: CellItem;
		judge: Judge;
		grid: PolicyGrid;
		lines: EvalLine[];
		human: MoveOutcome | null;
		/** The human's own previous moves (oldest first), for `previousOwnMoves`. */
		prevOwn: string[];
	}>;
}

export function groupGames(items: readonly CellItem[]): Game[] {
	const byKey = new Map<string, CellItem[]>();
	for (const it of items) {
		const key = `${it.row.gameId ?? it.row.id}:${it.row.color ?? ""}`;
		const list = byKey.get(key) ?? [];
		list.push(it);
		byKey.set(key, list);
	}
	const games: Game[] = [];
	for (const [key, list] of byKey) {
		list.sort((a, b) => a.row.ply - b.row.ply);
		const own: string[] = [];
		games.push({
			key,
			player: list[0]?.row.player ?? key,
			items: list.map((item) => {
				const judge = judgeFor(item.frame);
				const entry = {
					item,
					judge,
					grid: new PolicyGrid(item.policies),
					lines: item.frame.lines.filter((l) => l.pvUci[0] !== undefined && l.pvUci[0] !== ""),
					human: judge.outcome(item.row.humanMove),
					prevOwn: [...own],
				};
				if (item.row.prevOwnMove !== undefined && own.at(-1) !== item.row.prevOwnMove)
					own.push(item.row.prevOwnMove);
				own.push(item.row.humanMove);
				return entry;
			}),
		});
	}
	games.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return games;
}

/** The first complete cycle at depth ≥ `d`, as the selector's `shallowLines`. */
function shallowFrame(
	frame: FrameCacheRecord,
	d: number
): { lines: EvalLine[]; depth: number } | null {
	const roots = frame.byDepth[d];
	const at = frame.byDepthAt[d];
	if (!roots || roots.length === 0 || at === undefined) return null;
	return {
		depth: at,
		lines: roots.map((r, i) => ({
			multipv: i + 1,
			depth: at,
			score: r.score,
			pvUci: [r.uci],
			pvSan: [],
		})),
	};
}

export interface SimOptions {
	targetElo: number;
	table: MaiaCalibrationTable;
	chains: number;
	seed: string;
	/** Skip rows whose human move the referee never scored (no paired judgement). */
	requireHuman?: boolean;
}

/** One chain's pick at one row. */
export interface Draw {
	outcome: MoveOutcome;
	uci: string;
	selfElo: number;
	source: string;
}

export interface SimRow {
	gameKey: string;
	player: string;
	ply: number;
	/** Mover's clock over the base clock, before the move (clock-quartile reports). */
	clockFrac: number;
	human: MoveOutcome | null;
	/** One draw per chain. */
	draws: Draw[];
}

const MAX_OWN_REMEMBERED = 4;

/** Run the cell's games through `selectMove`, `chains` times each. */
export function simulate(games: readonly Game[], options: SimOptions): SimRow[] {
	const { table, ...rest } = options;
	return simulateMany(games, { ...rest, tables: [table] })[0] as SimRow[];
}

/** `simulate` for several tables at once: one `SimRow[]` per table, in `tables`' order. */
export interface SimManyOptions extends Omit<SimOptions, "table"> {
	tables: readonly MaiaCalibrationTable[];
}

/**
 * The same replay for several calibration tables, evaluated row-major — every table and chain at a
 * row before the next row — so the selector's per-root caches serve the whole sweep. Each
 * (table, chain) keeps its own state and its own rng, seeded identically across tables (common
 * random numbers: two tables differ only by what they change). The table-independent inputs —
 * the clock/think context and opponent pressure — are computed once per row and chain, then each
 * table's query rating is `maiaSelfElo` of them, exactly as `ownMoveMaiaElo` composes it.
 */
export function simulateMany(games: readonly Game[], options: SimManyOptions): SimRow[][] {
	const settings = DEFAULT_SETTINGS;
	const T = options.tables.length;
	const K = options.chains;
	const out: SimRow[][] = options.tables.map(() => []);
	for (const game of games) {
		const rows: SimRow[][] = options.tables.map(() =>
			game.items.map((g) => ({
				gameKey: game.key,
				player: game.player,
				ply: g.item.row.ply,
				clockFrac:
					(g.item.row.baseMs ?? 0) > 0 ? clamp(g.item.row.clockMs / (g.item.row.baseMs ?? 1), 0, 1) : 1,
				human: g.human,
				draws: [],
			}))
		);
		const taus = Array.from(
			{ length: K },
			(_, k) => samplePersona(`${game.key}:${k}`, "balanced", options.targetElo).tau
		);
		const rngs = options.tables.map(() =>
			Array.from({ length: K }, (_, k) => createRng(`${options.seed}:${game.key}:${k}`))
		);
		const states = options.tables.map(() => Array.from({ length: K }, () => createSelectionState()));
		for (const [i, g] of game.items.entries()) {
			const row = g.item.row;
			const baseMs = row.baseMs ?? 0;
			const incMs = row.incrementMs ?? 0;
			const phase = phaseOf(row.fen, row.ply) ?? "middlegame";
			const humanCp = g.judge.cpOf(row.humanMove);
			const context = taus.map((tau) =>
				ownMoveMaiaElo(
					{
						fen: row.fen,
						ply: row.ply,
						myClockMs: row.clockMs,
						oppClockMs: row.oppClockMs ?? row.clockMs,
						timeControl: baseMs > 0 || incMs > 0 ? { baseMs, incMs } : undefined,
						tau,
						budgetUsedRatio: baseMs > 0 ? clamp(1 - row.clockMs / baseMs, 0, 1) : 0,
						targetElo: options.targetElo,
						form: 0,
						maia: true,
					},
					settings
				)
			);
			for (let t = 0; t < T; t++) {
				const table = options.tables[t] as MaiaCalibrationTable;
				for (let k = 0; k < K; k++) {
					const terms = context[k] as (typeof context)[number];
					const selfElo = maiaSelfElo({
						targetElo: options.targetElo,
						form: 0,
						blunderScale: settings.strength.blunderScale,
						pressureReduction: terms.pressure.pressureReduction,
						contextEloPenalty: terms.contextEloPenalty,
						baseMs,
						incrementMs: incMs,
						calibration: table,
					});
					const state = (states[t] as SelectionState[])[k] as SelectionState;
					state.previousOwnMoves = g.prevOwn.slice(-MAX_OWN_REMEMBERED);
					const ctx: SelectionContext = {
						fen: row.fen,
						targetElo: options.targetElo,
						form: 0,
						ply: row.ply,
						phase,
						myClockMs: row.clockMs,
						oppClockMs: row.oppClockMs ?? row.clockMs,
						selectionMode: settings.strength.selectionMode,
						blunderScale: settings.strength.blunderScale,
						engineResultKind: "unrestricted",
						maia: g.grid.at(selfElo),
						contextEloPenalty: terms.contextEloPenalty,
						maiaCalibration: table,
						incrementMs: incMs,
						rng: (rngs[t] as Rng[])[k] as Rng,
						state,
					};
					if (baseMs > 0) ctx.baseMs = baseMs;
					if (row.lastMove !== undefined) ctx.lastMove = row.lastMove;
					if (g.item.frame.bestmove) ctx.engineBestmove = g.item.frame.bestmove;
					if (g.item.frame.extra.length > 0) ctx.maiaExtra = g.item.frame.extra;
					const shallow = shallowFrame(g.item.frame, humanDepth(selfElo));
					if (shallow) {
						ctx.shallowLines = shallow.lines;
						ctx.shallowDepth = shallow.depth;
					}
					const chosen = selectMove(g.lines, ctx);
					const outcome = g.judge.outcome(chosen.uci);
					if (!outcome) throw new Error(`${row.id}: the pick ${chosen.uci} is not a scored line`);
					((rows[t] as SimRow[])[i] as SimRow).draws.push({
						outcome,
						uci: chosen.uci,
						selfElo,
						source: chosen.source,
					});
					// The next position came from the human's move, not ours.
					if (humanCp === undefined) delete state.lastPickCp;
					else state.lastPickCp = humanCp;
				}
			}
		}
		for (let t = 0; t < T; t++)
			for (const r of rows[t] as SimRow[])
				if (!options.requireHuman || r.human !== null) (out[t] as SimRow[]).push(r);
	}
	return out;
}
