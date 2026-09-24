/**
 * tools/timing-calibration/sim.ts — the bot's clock-recorded think times on real human games,
 * the way the service worker plays them.
 *
 * Every selected (game, side) is replayed in ply order by `chains` independent chains; each chain
 * is one bot game at the human's advertised rating (a fresh `TimingModel` with the production
 * preset for the time control, persona from the chain's game id). The positions, clocks and the
 * opponent's moves and thinks are the recorded ones: at each own move the bot sees the context the
 * human saw and "plays" the human's move (so the situation label is the human's), and the time it
 * would have taken is what chess.com would record for it:
 *
 *   1. **Premove** (`PremoveArming.arm` → `QueuedPremove.enter` / `fireOnReply`). After its
 *      previous move the session arms a premove when `premoveCandidate` finds one for the reply it
 *      predicts; the engine-dependent part is computed once per row with the shipped function over
 *      cached frames (`premoveFacts`), the random gates are drawn per chain with the production
 *      probabilities (`premovePropensity` under the table, else the strength propensities). If
 *      the opponent then plays the predicted reply: a queueable candidate that the opponent's
 *      think left time to enter (arming searches + entry delay + the gesture) is a site premove,
 *      recorded as 0.1 s; otherwise the fast reply (`fireOnReply`), realised as the hand measured
 *      it (`FIRE_MS`).
 *   2. **Planned move**. `TimingModel.planMove` with the production `TimingContext` (the shipped
 *      ChessMimic band's cached distribution, the frame's lines, the ponder's expected reply,
 *      the book flag, the prior position, the hover square when the idle hand anticipated), then
 *      the executor: the search's preparation (`ownMoveBudget`'s movetime; a cache hit when the
 *      opponent played the predicted reply after the pre-analysis finished; the fast-reply cap
 *      when enabled), and the hand, which starts at `max(deadline − approach, preparation)` and
 *      takes `max(approach, natural touch)` unless the plan is an anticipated prepared touch
 *      (realised as planned). `observe` feeds the release back as the session does.
 *
 * The recorded value is `ceil(release / 100 ms) · 100 ms` (chess.com's tenth-second clock).
 */

import "../lib/defines";
import { existsSync } from "node:fs";
import path from "node:path";
import { classifyMove } from "@core/chess/move-classify";
import { legalMoves } from "@core/chess/san";
import { PREMOVE, SEARCH_BUDGET } from "@core/constants";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { TABLEBASE } from "@core/constants/tablebase";
import type { TimingCalibrationTable } from "@core/constants/timing-calibration";
import { anticipationEngageProb } from "@core/motor/anticipation";
import { FAST_TOUCH } from "@core/motor/constants";
import { createRng, type Rng } from "@core/rng";
import { isMaxStrength } from "@core/strength/max-strength";
import {
	isQueueableCandidate,
	premoveCandidate,
	premoveProbability,
	replyProbability,
	tradePremoveProbability,
} from "@core/strength/premove";
import { plausibleScore, predictionLines } from "@core/strength/premove/prediction";
import { pieceCount } from "@core/tablebase/probe";
import {
	calibrationTimeClass,
	isObviousRecapture,
	premovePropensity,
} from "@core/timing/calibration";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { tcClass } from "@core/timing/features";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { timingSettingsFor } from "@service/game-session/presets";
import {
	maiaPlaysOpening,
	maiaSearchMode,
	ownMoveBudget,
} from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import type { Square } from "@typedefs/game";
import { type CorpusGame, DATA_DIR, PATHS, readJsonl, rowsOf, type TimingRow } from "./common";
import { type CompactLine, loadFrames, toEvalLines } from "./frames";
import { type HeadResult, headsPath, rowContext } from "./heads";
import { SELECT_PATH, type Selection } from "./select";

// ── the latency model (the parts no browser measured for us; see the doc) ────────────────────

export const LATENCY = {
	/** Page → service worker on arrival plus CDP release → page: an assumption (the hover sim has none). */
	transportMs: 30,
	/** A search's stop receipt and the pipeline's bookkeeping after its deadline. */
	prepOverheadMs: 25,
	/** A pre-analysed (cache-hit) own move: policy and bookkeeping only. */
	hitPrepMs: 40,
	/** The two arming searches (`PREMOVE.ponderMovetimeMs + replyMovetimeMs`) after our move lands. */
	armMs: 340,
	/** Harvesting the ponder's prediction when nothing was armed. */
	harvestMs: 60,
	/**
	 * The hand's natural touch when a plan is late (`hover`, 60 seeds at 2700): p10/p50/p90
	 * 383/453/539 ms from rest, 334/403/497 ms with the hand hovering on the piece. Log-normal.
	 */
	naturalMs: { median: 453, sigma: 0.135 },
	naturalHoverMs: { median: 403, sigma: 0.16 },
	/** `fireOnReply` arrival → release, measured by `hover` (n = 13): the empirical sample. */
	fireMs: [118, 118, 120, 248, 248, 253, 321, 321, 335, 344, 351, 405, 442],
	/** Gesture of a queued premove's drag (`FAST_TOUCH.gestureFloorMs` and the carry). */
	queueGestureMs: 180,
} as const;

export function recordedMs(releaseMs: number): number {
	return Math.max(100, Math.ceil(releaseMs / 100 - 1e-9) * 100);
}

// ── data ─────────────────────────────────────────────────────────────────────────────────────

/** The engine-dependent half of the arm for a row: what `premoveCandidate` returns if every draw passes. */
export interface PremoveFacts {
	reply: string;
	premove: string;
	reason: string;
	queueable: boolean;
	safeTrade: boolean;
	/** The candidate was the primary prediction (ordinary premoves need that). */
	primary: boolean;
}

export interface ReplayRow {
	row: TimingRow;
	lines: EvalLine[];
	/** The ponder's expected reply after our previous move (best line of the opponent's position). */
	predicted: string | null;
	/** Our answer in that best line (where the idle hand anticipates). */
	pondered: string | null;
	premove: PremoveFacts | null;
	/** The same under the calibrated trade gate (`PREMOVE.tradeReplyMinProb`). */
	premoveRelaxed: PremoveFacts | null;
	/** The fast-reply rule's recapture case holds (see `isFastReply`). */
	recaptureDecided: boolean;
	oppThinks: number[];
	head: HeadResult | null;
	/** `ownMoveBudget`'s movetime per chain (the persona's `tau` is fixed per chain key), filled lazily. */
	movetime: number[];
}

export interface ReplaySide {
	key: string;
	game: CorpusGame;
	color: "w" | "b";
	split: string;
	rows: ReplayRow[];
}

const ALWAYS: Rng = (() => {
	const r = createRng("always");
	return { ...r, chance: () => true, next: () => 0 };
})();

function compact(lines: CompactLine[] | undefined, depth: number): EvalLine[] {
	return lines ? toEvalLines(lines, depth) : [];
}

/**
 * `premoveCandidate` over cached frames with every draw passing (piP 1). `relaxed` is the
 * calibrated gate (`tradeReplyMinProb` for captures). Only the played reply's position has a
 * frame, so a reply the prediction ranks before it that could itself arm (it passes its own gate)
 * is assumed to take the arm, which is pessimistic for the played one.
 */
async function premoveFacts(
	game: CorpusGame,
	frames: CompactLine[][],
	depth: number,
	row: TimingRow,
	relaxed: boolean
): Promise<PremoveFacts | null> {
	const t = row.ply;
	if (t < 2) return null;
	const oppLines = compact(frames[t - 1], depth);
	const actual = game.ucis[t - 1] as string;
	const afterMove = game.fens[t - 1] as string;
	const gateOf = (reply: string): number =>
		relaxed && classifyMove(afterMove, reply)?.isCapture === true
			? PREMOVE.tradeReplyMinProb
			: PREMOVE.replyMinProb;
	if (replyProbability(actual, oppLines) < gateOf(actual)) return null;
	const legal = legalMoves(afterMove);
	const ranked = predictionLines(oppLines, legal);
	const best = ranked[0];
	for (const line of ranked) {
		const reply = line.pvUci[0];
		if (!reply || reply === actual) break;
		if (best && plausibleScore(line, best) && replyProbability(reply, ranked) >= gateOf(reply))
			return null;
	}
	const ownLines = compact(frames[t], depth);
	const fenBefore = game.fens[t - 2] as string;
	const move = game.ucis[t - 2] as string;
	const oppPly = game.plies.find((p) => p.ply === t - 1);
	const candidate = await premoveCandidate(
		{
			fen: fenBefore,
			move,
			historyAfterMove: { fen: game.fens[0] as string, moves: game.ucis.slice(0, t - 1) },
			targetElo: row.rating,
			timeControl: { baseMs: row.baseMs, incMs: row.incMs },
			ownClockMs: row.clockMs,
			opponentClockMs: oppPly ? oppPly.clockMs : row.oppClockMs,
			ponder: oppLines[0]?.pvUci[0],
			rng: ALWAYS,
			piP: 1,
			...(relaxed ? { propensity: { tradeReplyMinProb: PREMOVE.tradeReplyMinProb } } : {}),
		},
		{
			analyseAfter: async (_fen, moves) =>
				moves.length === 1 ? oppLines : moves[1] === actual ? ownLines : [],
		}
	);
	if (!candidate || candidate.reply !== actual) return null;
	const queueable = isQueueableCandidate(afterMove, candidate);
	return {
		reply: candidate.reply,
		premove: candidate.premove,
		reason: candidate.reason,
		queueable,
		safeTrade: candidate.reason === "recapture" && queueable,
		primary: oppLines[0]?.pvUci[0] === candidate.reply,
	};
}

export interface ReplayData {
	sides: ReplaySide[];
}

/** Load the selection, frames and heads, and precompute the deterministic per-row facts. */
export async function loadReplay(
	options: { headsTag?: string; limitSides?: number } = {}
): Promise<ReplayData> {
	const selection = (await Bun.file(SELECT_PATH).json()) as Selection;
	const frames = await loadFrames();
	const heads = new Map<string, HeadResult>();
	// `SL_HEADS_TAG` selects a candidate band set's cached outputs (`heads.<tag>.jsonl`) for every tool.
	const headsFile = headsPath(options.headsTag ?? process.env.SL_HEADS_TAG ?? "");
	if (existsSync(headsFile))
		for await (const h of readJsonl<HeadResult>(headsFile, true)) heads.set(h.id, h);
	const wanted = new Map<string, Array<{ color: "w" | "b"; split: string }>>();
	for (const s of selection.sides) {
		const list = wanted.get(s.gameId) ?? [];
		list.push({ color: s.color, split: s.split });
		wanted.set(s.gameId, list);
	}
	// The engine-dependent facts are cached per row (`replay-facts.jsonl`), keyed by the rules
	// they depend on; a change of those constants recomputes them.
	const version = JSON.stringify({ PREMOVE, maxPieces: TABLEBASE.maxPieces, v: 2 });
	const factsFile = path.join(DATA_DIR, "replay-facts.jsonl");
	const cached = new Map<string, RowFacts>();
	if (existsSync(factsFile)) {
		let first = true;
		for await (const rec of readJsonl<RowFacts & { version?: string }>(factsFile, true)) {
			if (first) {
				first = false;
				if (rec.version !== version) break;
				continue;
			}
			cached.set(rec.id, rec);
		}
	}
	const fresh: RowFacts[] = [];
	const sides: ReplaySide[] = [];
	for await (const g of readJsonl<CorpusGame>(PATHS.selectGames)) {
		const want = wanted.get(g.gameId);
		const f = frames.get(g.gameId);
		if (!want || !f) continue;
		const all = rowsOf(g);
		const byPly = new Map(all.map((r) => [r.ply, r]));
		for (const { color, split } of want) {
			const rows: ReplayRow[] = [];
			const oppThinks: number[] = [];
			for (let ply = 0; ply < g.ucis.length; ply++) {
				const r = byPly.get(ply);
				const own = ply % 2 === (color === "w" ? 0 : 1);
				if (!own) {
					if (r) oppThinks.push(r.thinkMs);
					continue;
				}
				if (!r || r.first) continue;
				const oppFrame = compact(f.plies[ply - 1], f.depth);
				const lastMove = g.ucis[ply - 1];
				const predicted = oppFrame[0]?.pvUci[0] ?? null;
				const pondered = oppFrame[0]?.pvUci[1] ?? null;
				// The fast-reply rule's recapture: the opponent's-turn analysis predicted this reply and
				// rated an obvious recapture our best answer (`ponderedAnswer`); not in tablebase range.
				let facts = cached.get(r.id);
				if (!facts) {
					facts = {
						id: r.id,
						// The fast-reply rule's recapture: the opponent's-turn analysis predicted this reply
						// and rated an obvious recapture our best answer (`ponderedAnswer`); not in
						// tablebase range.
						recaptureDecided:
							lastMove !== undefined &&
							predicted === lastMove &&
							pondered !== null &&
							(pieceCount(r.fen) ?? 0) > TABLEBASE.maxPieces &&
							isObviousRecapture(g.fens[ply - 1], lastMove, r.fen, pondered),
						premove: await premoveFacts(g, f.plies, f.depth, r, false),
						premoveRelaxed: await premoveFacts(g, f.plies, f.depth, r, true),
					};
					fresh.push(facts);
				}
				rows.push({
					row: r,
					lines: compact(f.plies[ply], f.depth),
					predicted,
					pondered,
					premove: facts.premove,
					premoveRelaxed: facts.premoveRelaxed,
					recaptureDecided: facts.recaptureDecided,
					oppThinks: [...oppThinks],
					head: heads.get(r.id) ?? null,
					movetime: [],
				});
			}
			if (rows.length > 0) sides.push({ key: `${g.gameId}:${color}`, game: g, color, split, rows });
			if (options.limitSides && sides.length >= options.limitSides) return { sides };
		}
	}
	if (fresh.length > 0) {
		const lines = [
			JSON.stringify({ version }),
			...[...cached.values(), ...fresh].map((f) => JSON.stringify(f)),
		];
		await Bun.write(factsFile, `${lines.join("\n")}\n`);
	}
	return { sides };
}

/** The engine-dependent facts of a row, cached across runs. */
interface RowFacts {
	id: string;
	recaptureDecided: boolean;
	premove: PremoveFacts | null;
	premoveRelaxed: PremoveFacts | null;
}

// ── the replay ───────────────────────────────────────────────────────────────────────────────

export interface SimOptions {
	table: TimingCalibrationTable;
	/** The session's fast-reply search cap (book answer / obvious recapture). */
	fastReply: boolean;
	/** The idle hand's anticipatory hover (and the timing model's prepared touch). */
	hover: boolean;
	chains: number;
	seed: string;
	/**
	 * Closed loop: the bot plays on its **own** clock (base, minus its recorded thinks, plus the
	 * increment) instead of the human's, and a chain that runs out stops (`onFlag`). The head's
	 * cached distribution stays the one conditioned on the human's clock; the budget, the caps and
	 * the clock policies see the bot's.
	 */
	ownClock?: boolean;
	onFlag?: (sideKey: string, chain: number, ply: number) => void;
	/** Closed loop: the bot's clock after each of its moves. */
	onClock?: (sideKey: string, chain: number, ply: number, clockMs: number, thinkMs: number) => void;
}

export type BotPath = "queued" | "fire" | "plan";

export interface SimRowResult {
	id: string;
	/** Recorded think per chain (ms). */
	bot: number[];
	path: BotPath[];
}

function logNormalMs(rng: Rng, p: { median: number; sigma: number }): number {
	return p.median * Math.exp(rng.normal(0, p.sigma));
}

const HEAD_FALLBACK = new V1ParametricHead();

/** One chain over one side: a bot game stepped row by row (chains run in lockstep per row). */
class Chain {
	private readonly step: (rr: ReplayRow) => Promise<{ ms: number; path: BotPath }>;
	constructor(side: ReplaySide, chain: number, opts: SimOptions) {
		this.step = chainStepper(side, chain, opts);
	}
	next(rr: ReplayRow): Promise<{ ms: number; path: BotPath }> {
		return this.step(rr);
	}
}

function chainStepper(
	side: ReplaySide,
	chain: number,
	opts: SimOptions
): (rr: ReplayRow) => Promise<{ ms: number; path: BotPath }> {
	const { game } = side;
	const first = side.rows[0]?.row as TimingRow;
	const key = `${side.key}:${chain}`;
	const baseSec = first.baseMs / 1000;
	const incSec = first.incMs / 1000;
	let cached: HeadResult | null = null;
	const head = new ChessMimicHead({
		infer: async () => (cached ? { probs: cached.probs, band: cached.band } : null),
		fallback: HEAD_FALLBACK,
		budgetMs: 60_000,
	});
	const model = new TimingModel(
		head,
		timingSettingsFor(DEFAULT_SETTINGS.timing, { baseMs: first.baseMs, incMs: first.incMs }),
		createRng(`${opts.seed}:${key}`),
		{ calibration: opts.table }
	);
	model.startGame({
		gameId: key,
		targetElo: first.rating,
		profile: "balanced",
		baseSec,
		incSec,
		site: "chesscom",
	});
	const rng = createRng(`${opts.seed}:${key}:session`);
	const timeClass = calibrationTimeClass(baseSec, incSec);
	const lichessClass = tcClass(baseSec, incSec);
	const premoveSpeed = lichessClass === "bullet" || lichessClass === "blitz";
	const myThinks: number[] = [];
	let clock = first.baseMs;
	let flagged = false;
	const settle = (ms: number, path: BotPath, r: TimingRow): { ms: number; path: BotPath } => {
		if (opts.ownClock) {
			clock += r.incMs - ms;
			opts.onClock?.(side.key, chain, r.ply, clock, ms);
			if (clock <= 0 && !flagged) {
				flagged = true;
				opts.onFlag?.(side.key, chain, r.ply);
			}
		}
		return { ms, path };
	};
	return async (rr: ReplayRow) => {
		if (flagged) return { ms: Number.NaN, path: "plan" };
		const r: TimingRow = opts.ownClock ? { ...rr.row, clockMs: Math.max(0, clock) } : rr.row;
		const persona = model.persona;
		const piP = 1 / (1 + Math.exp(-(persona.pi_p + model.state.knobs.piOffset)));
		const oppThink = r.oppThinkMs ?? 0;
		const actual = game.ucis[r.ply - 1] ?? null;
		// 1. The premove armed after our previous move.
		const cal0 = premovePropensity(timeClass, r.rating, 0.5, opts.table);
		const facts = cal0.tradeReplyMinProb !== undefined ? rr.premoveRelaxed : rr.premove;
		if (facts) {
			const cal = premovePropensity(timeClass, r.rating, piP, opts.table);
			const ordinaryP = cal.ordinary ?? premoveProbability(r.rating, piP);
			const tradeP = cal.trade ?? tradePremoveProbability(r.rating, piP);
			const p = Math.max(ordinaryP, tradeP);
			const armed =
				p > 0 &&
				rng.chance(p) &&
				(facts.safeTrade ||
					(premoveSpeed && ordinaryP > 0 && facts.primary && rng.chance(ordinaryP / p)));
			if (armed) {
				const race = clockRacePolicy({
					ownClockMs: r.clockMs,
					opponentClockMs: r.oppClockMs + oppThink,
					baseMs: r.baseMs,
					incrementMs: r.incMs,
				});
				const [dMin, dMax] = race
					? [PREMOVE.fastQueueDelayMinMs, PREMOVE.fastQueueDelayMaxMs]
					: facts.reason === "recapture"
						? [PREMOVE.tradeQueueDelayMinMs, PREMOVE.tradeQueueDelayMaxMs]
						: [PREMOVE.queueDelayMinMs, PREMOVE.queueDelayMaxMs];
				const delay = dMin + rng.next() * (dMax - dMin);
				const window = rng.next() * PREMOVE.fastQueueDelayMaxMs;
				const queued =
					facts.queueable && oppThink >= LATENCY.armMs + delay + LATENCY.queueGestureMs + window;
				if (queued) {
					myThinks.push(100);
					return settle(100, "queued", r);
				}
				const fire = LATENCY.fireMs[rng.int(0, LATENCY.fireMs.length - 1)] ?? 300;
				const release = LATENCY.transportMs + fire;
				myThinks.push(release);
				return settle(recordedMs(release), "fire", r);
			}
		}
		// 2. The planned move.
		const predicted = rr.predicted;
		let hoverSquare: Square | null = null;
		let engaged = false;
		if (opts.hover && predicted && rr.pondered) {
			const kind = rr.pondered.slice(2, 4) === predicted.slice(2, 4) ? "recapture" : "ponder";
			engaged = rng.chance(anticipationEngageProb(kind, lichessClass));
			if (engaged) hoverSquare = rr.pondered.slice(0, 2) as Square;
		}
		cached = rr.head;
		const ctx: TimingContext = {
			...rowContext(game, r),
			myClockMs: r.clockMs,
			lines: rr.lines,
			evalBeforeOppMove: model.state.lastEvalOurPov,
			expectedOppReply: predicted,
			oppThinkMsHistory: rr.oppThinks,
			myThinkMsHistory: [...myThinks],
			priorFen: game.fens[r.ply - 1] ?? null,
			hoverSquare,
			...(r.inBook ? { inBook: true } : {}),
		};
		await model.prepare(ctx);
		const plan = model.planMove(ctx);
		const race = clockRacePolicy({
			ownClockMs: r.clockMs,
			opponentClockMs: r.oppClockMs,
			baseMs: r.baseMs,
			incrementMs: r.incMs,
		});
		const maia = maiaSearchMode({ targetElo: r.rating, policy: true, clockRace: race !== null });
		let budgetMs = opts.ownClock ? undefined : rr.movetime[chain];
		if (budgetMs === undefined) {
			budgetMs = ownMoveBudget(
				{
					fen: r.fen,
					ply: r.ply,
					myClockMs: r.clockMs,
					oppClockMs: r.oppClockMs,
					timeControl: { baseMs: r.baseMs, incMs: r.incMs },
					tau: persona.tau,
					budgetUsedRatio: r.baseMs > 0 ? Math.max(0, Math.min(1, 1 - r.clockMs / r.baseMs)) : 0,
					targetElo: r.rating,
					form: 0,
					maia,
				},
				DEFAULT_SETTINGS
			).movetimeMs;
			if (!opts.ownClock) rr.movetime[chain] = budgetMs;
		}
		let movetime = budgetMs;
		if (opts.fastReply && !isMaxStrength(r.rating)) {
			const bookFast =
				r.inBook &&
				!maiaPlaysOpening({ targetElo: r.rating, form: 0 }) &&
				(pieceCount(r.fen) ?? 0) > TABLEBASE.maxPieces;
			if (bookFast || rr.recaptureDecided)
				movetime = Math.min(movetime, SEARCH_BUDGET.fastReplyMs[lichessClass]);
		}
		const preStart = premoveSpeed ? LATENCY.armMs : LATENCY.harvestMs;
		const hit =
			(premoveSpeed || race !== null) &&
			predicted !== null &&
			predicted === actual &&
			oppThink >= preStart + movetime;
		const prep = hit ? LATENCY.hitPrepMs : movetime + LATENCY.prepOverheadMs;
		const approach = plan.window.approachMs;
		// A clock race (own emergency, lone king) runs the fast touch: its gesture floor, not the
		// natural touch (`fastTouch` in the executor); an anticipated plan runs as planned.
		const urgent = (plan.features.clockRace ?? 0) > 0 || (plan.features.loneKing ?? 0) > 0;
		const hand =
			plan.features.anticipated === 1
				? approach
				: urgent
					? Math.max(approach, FAST_TOUCH.gestureFloorMs)
					: Math.max(approach, logNormalMs(rng, engaged ? LATENCY.naturalHoverMs : LATENCY.naturalMs));
		const start = Math.max(plan.thinkMs - approach, prep);
		const release = start + hand + LATENCY.transportMs;
		model.observe(release, plan, {
			gameId: key,
			ply: r.ply,
			adaptPace: release <= plan.thinkMs + 10,
		});
		myThinks.push(release);
		return settle(recordedMs(release), "plan", r);
	};
}

/** Replay every side `chains` times; results keyed by row id. */
export async function simulate(
	data: ReplayData,
	opts: SimOptions,
	filter?: (s: ReplaySide) => boolean
): Promise<Map<string, SimRowResult>> {
	const results = new Map<string, SimRowResult>();
	for (const side of data.sides) {
		if (filter && !filter(side)) continue;
		if (side.rows.length === 0) continue;
		const chains = Array.from({ length: opts.chains }, (_, c) => new Chain(side, c, opts));
		for (const rr of side.rows) {
			const res: SimRowResult = { id: rr.row.id, bot: [], path: [] };
			for (const chain of chains) {
				const d = await chain.next(rr);
				if (Number.isNaN(d.ms)) continue;
				res.bot.push(d.ms);
				res.path.push(d.path);
			}
			if (res.bot.length > 0) results.set(rr.row.id, res);
		}
	}
	return results;
}
