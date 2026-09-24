/**
 * tools/calibration/sim/replay.ts — the replay itself: every (table, chain) walks each game's rows
 * the way the service worker plays an own move (see `sim.ts`), row-major so the selector's
 * per-root caches serve a whole sweep, with common random numbers across tables.
 */

import "../../lib/defines";
import { phase as phaseOf } from "@core/chess/phase";
import type { MaiaCalibrationTable } from "@core/constants/maia-calibration";
import { humanDepth } from "@core/engine/depth-policy";
import { createRng, type Rng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { maiaSelfElo } from "@core/strength/selection-elo";
import type { SelectionContext, SelectionState } from "@core/strength/types";
import { samplePersona } from "@core/timing/persona-latents";
import { clamp } from "@core/util/clamp";
import { ownMoveMaiaElo } from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import { DEFAULT_SETTINGS } from "@typedefs/settings";
import type { FrameCacheRecord } from "../frames/schema";
import type { Game } from "./games";
import type { MoveOutcome, PositionShape } from "./judge";

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
	/** The human mover's chess.com rating. */
	rating: number;
	shape: PositionShape;
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
				rating: g.item.row.selfElo,
				shape: g.judge.shape,
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
