/**
 * tools/timing-calibration/sim/chain.ts — one chain: a bot game over one replayed side, stepped row
 * by row. Each step is either the premove armed after the previous move (`armedPremove`: a site
 * premove or the fast reply) or the planned move (`plannedRelease`: `planMove`, preparation, the
 * hand). The random draws happen in that order on the chain's session stream.
 */

import { PREMOVE, SEARCH_BUDGET } from "@core/constants";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { TABLEBASE } from "@core/constants/tablebase";
import { anticipationEngageProb } from "@core/motor/anticipation";
import { FAST_TOUCH } from "@core/motor/constants";
import { createRng, type Rng } from "@core/rng";
import { isMaxStrength } from "@core/strength/max-strength";
import { premoveProbability, tradePremoveProbability } from "@core/strength/premove";
import { pieceCount } from "@core/tablebase/probe";
import { calibrationTimeClass, premovePropensity } from "@core/timing/calibration";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { tcClass } from "@core/timing/features";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import { TimingModel } from "@core/timing/timing-model";
import type { Persona, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { timingSettingsFor } from "@service/game-session/presets";
import {
	maiaPlaysOpening,
	maiaSearchMode,
	ownMoveBudget,
} from "@service/game-session/recommendation";
import type { Square } from "@typedefs/game";
import type { TimingRow } from "../common";
import { type HeadResult, rowContext } from "../heads";
import { LATENCY, logNormalMs, recordedMs } from "./latency";
import type { ReplayRow, ReplaySide } from "./replay-data";
import type { BotPath, SimOptions } from "./types";

export type ChainStep = { ms: number; path: BotPath };

const HEAD_FALLBACK = new V1ParametricHead();

/** What a chain's steps share: the side, the bot's model, its session stream and its history. */
interface ChainScope {
	side: ReplaySide;
	chain: number;
	opts: SimOptions;
	key: string;
	model: TimingModel;
	rng: Rng;
	timeClass: ReturnType<typeof calibrationTimeClass>;
	lichessClass: ReturnType<typeof tcClass>;
	premoveSpeed: boolean;
	myThinks: number[];
	/** Point the head at a row's cached distribution. */
	useHead(head: HeadResult | null): void;
}

/**
 * The premove armed after our previous move, when the opponent then played the predicted reply:
 * a queueable candidate the opponent's think left time to enter is a site premove (0.1 s),
 * anything else the fast reply as the hand measured it. Null when nothing was armed.
 */
function armedPremove(
	s: ChainScope,
	rr: ReplayRow,
	r: TimingRow,
	persona: Persona
): { think: number; step: ChainStep } | null {
	const { model, rng, opts } = s;
	const piP = 1 / (1 + Math.exp(-(persona.pi_p + model.state.knobs.piOffset)));
	const oppThink = r.oppThinkMs ?? 0;
	const cal0 = premovePropensity(s.timeClass, r.rating, 0.5, opts.table);
	const facts = cal0.tradeReplyMinProb !== undefined ? rr.premoveRelaxed : rr.premove;
	if (!facts) return null;
	const cal = premovePropensity(s.timeClass, r.rating, piP, opts.table);
	const ordinaryP = cal.ordinary ?? premoveProbability(r.rating, piP);
	const tradeP = cal.trade ?? tradePremoveProbability(r.rating, piP);
	const p = Math.max(ordinaryP, tradeP);
	const armed =
		p > 0 &&
		rng.chance(p) &&
		(facts.safeTrade
			? tradeP >= p || rng.chance(tradeP / p)
			: s.premoveSpeed && ordinaryP > 0 && facts.primary && rng.chance(ordinaryP / p));
	if (!armed) return null;
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
	if (queued) return { think: 100, step: { ms: 100, path: "queued" } };
	const fire = LATENCY.fireMs[rng.int(0, LATENCY.fireMs.length - 1)] ?? 300;
	const release = LATENCY.transportMs + fire;
	return { think: release, step: { ms: recordedMs(release), path: "fire" } };
}

/** The own-move search's movetime: `ownMoveBudget`, cached per chain on the open-loop replay. */
function movetimeFor(s: ChainScope, rr: ReplayRow, r: TimingRow, persona: Persona): number {
	const { opts, chain } = s;
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
			movetime = Math.min(movetime, SEARCH_BUDGET.fastReplyMs[s.lichessClass]);
	}
	return movetime;
}

/**
 * The planned move's release: `planMove` with the production context (the hover square when the
 * idle hand anticipated), preparation (the search, or a cache hit on the predicted reply), then
 * the hand; `observe` feeds the release back as the session does.
 */
async function plannedRelease(
	s: ChainScope,
	rr: ReplayRow,
	r: TimingRow,
	persona: Persona
): Promise<number> {
	const { model, rng, opts, side } = s;
	const game = side.game;
	const oppThink = r.oppThinkMs ?? 0;
	const actual = game.ucis[r.ply - 1] ?? null;
	const predicted = rr.predicted;
	let hoverSquare: Square | null = null;
	let engaged = false;
	if (opts.hover && predicted && rr.pondered) {
		const kind = rr.pondered.slice(2, 4) === predicted.slice(2, 4) ? "recapture" : "ponder";
		engaged = rng.chance(anticipationEngageProb(kind, s.lichessClass));
		if (engaged) hoverSquare = rr.pondered.slice(0, 2) as Square;
	}
	s.useHead(rr.head);
	const ctx: TimingContext = {
		...rowContext(game, r),
		myClockMs: r.clockMs,
		lines: rr.lines,
		evalBeforeOppMove: model.state.lastEvalOurPov,
		expectedOppReply: predicted,
		oppThinkMsHistory: rr.oppThinks,
		myThinkMsHistory: [...s.myThinks],
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
	const movetime = movetimeFor(s, rr, r, persona);
	const preStart = s.premoveSpeed ? LATENCY.armMs : LATENCY.harvestMs;
	const hit =
		(s.premoveSpeed || race !== null) &&
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
		gameId: s.key,
		ply: r.ply,
		adaptPace: release <= plan.thinkMs + 10,
	});
	return release;
}

/** A chain over one side: a fresh bot game, stepped row by row (chains run in lockstep per row). */
export function chainStepper(
	side: ReplaySide,
	chain: number,
	opts: SimOptions
): (rr: ReplayRow) => Promise<ChainStep> {
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
	const lichessClass = tcClass(baseSec, incSec);
	const scope: ChainScope = {
		side,
		chain,
		opts,
		key,
		model,
		rng: createRng(`${opts.seed}:${key}:session`),
		timeClass: calibrationTimeClass(baseSec, incSec),
		lichessClass,
		premoveSpeed: lichessClass === "bullet" || lichessClass === "blitz",
		myThinks: [],
		useHead: (h) => {
			cached = h;
		},
	};
	let clock = first.baseMs;
	let flagged = false;
	const settle = (ms: number, path: BotPath, r: TimingRow): ChainStep => {
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
		const premove = armedPremove(scope, rr, r, persona);
		if (premove) {
			scope.myThinks.push(premove.think);
			return settle(premove.step.ms, premove.step.path, r);
		}
		const release = await plannedRelease(scope, rr, r, persona);
		scope.myThinks.push(release);
		return settle(recordedMs(release), "plan", r);
	};
}
