/**
 * ChessMimic timing head (§8.4b item 6, Appendix J §B; Task 34). The service-worker side of
 * the shipped head: it builds the model inputs (`chessmimic-tokeniser`: FEN tokens, last-12
 * move window; raw rating and clocks, the virtual 300 s clock for clockless games), picks the
 * nearest registered band, sends the query through the injected `infer` port (normally
 * `createTimingInferPort` over the engine port → `timing-inference.ts` in the offscreen
 * document, onnxruntime-web) and decodes the 30 bucket probabilities that come back:
 * `player_clock + increment` mask, temperature-scaled bucket draw, empirical within-bucket
 * draw (`chessmimic-buckets`), persona `s_game` shift and the AR(1) residual on top.
 *
 * The offscreen host standardises the rating/clocks with the scalers of the band that actually
 * answers (it may substitute the nearest loaded band), so the reply names that band and the
 * decoding uses its bucket tables. Inference runs under a 100 ms budget; on timeout, load
 * failure, a malformed reply or an unprepared position the v1 head answers.
 */

import type { TimingInferenceInputs } from "@core/constants/messages";
import type { ChessMimicBand } from "@core/constants/models";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import {
	bucketMask,
	CHESSMIMIC_BUCKETS,
	CLOCK_BUCKET_BOUNDARIES,
	distributionMedianSec,
	sampleBucket,
	sampleWithinBucket,
} from "./chessmimic-buckets";
import { bandCentre } from "./chessmimic-scalers";
import { encodeRecentMoves, tokenizeFen } from "./chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "./constants";
import { sigmoid } from "./distributions";
import { tcClass } from "./features";
import { premoveLogit, urgencyFactor } from "./pressure";
import type {
	DistributionHead,
	Features,
	GameTimingState,
	HeadSample,
	Persona,
	TimingContext,
} from "./types";

const CM = TIMING_CONSTANTS.chessmimic;
const UNTIMED = TIMING_CONSTANTS.untimedVirtual;

export type { ChessMimicBand };
export const CHESSMIMIC_BANDS: readonly ChessMimicBand[] = CM.bands;

/** Nearest registered band to the target Elo (ties → the lower band). */
export function selectBand(targetElo: number): ChessMimicBand {
	let best: ChessMimicBand = CHESSMIMIC_BANDS[0] ?? "1500_1600";
	let bestDist = Number.POSITIVE_INFINITY;
	for (const band of CHESSMIMIC_BANDS) {
		const d = Math.abs(targetElo - bandCentre(band));
		if (d < bestDist) {
			bestDist = d;
			best = band;
		}
	}
	return best;
}

function isRegisteredBand(band: string): band is ChessMimicBand {
	return Object.hasOwn(CHESSMIMIC_BUCKETS, band);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The `timing` port payload with the band narrowed to a registered one. */
export interface ChessMimicInputs extends TimingInferenceInputs {
	band: ChessMimicBand;
}

/** Build the model inputs from a `TimingContext`; clockless games get the fixed virtual clock. */
export function buildInputs(ctx: TimingContext): ChessMimicInputs {
	const untimed = tcClass(ctx.baseSec, ctx.incSec) === "untimed";
	const moveTokens = encodeRecentMoves(ctx.moves);
	const fenTokens = tokenizeFen(ctx.fen);
	const sequenceLength = moveTokens.length + 2 + fenTokens.length;
	if (sequenceLength !== CM.sequenceLength)
		throw new RangeError(
			`chessmimic inputs: ${sequenceLength} tokens, expected ${CM.sequenceLength}`
		);
	return {
		band: selectBand(ctx.targetElo),
		moveTokens,
		fenTokens,
		rating: ctx.targetElo,
		playerClockS: untimed ? UNTIMED.clockS : Math.max(0, ctx.myClockMs / 1000),
		opponentClockS: untimed ? UNTIMED.clockS : Math.max(0, ctx.oppClockMs / 1000),
		incrementS: untimed ? UNTIMED.incS : ctx.incSec,
	};
}

// ---------------------------------------------------------------------------
// How often the head may answer `instant`
// ---------------------------------------------------------------------------

/**
 * The share of **real** human moves that reach the board inside `fastMoveMaxS`, read off the band's
 * own empirical prior: `buckets.json` `bucket_probabilities` over 1 000 000 human blitz moves a band,
 * summed across every bucket whose upper edge is at or below that bound. 17.8 % at 1200–1300, 21.3 %
 * at 1500–1600, 24.7 % at 1800–1900 — stronger players snap more often, and the budget follows the
 * data rather than a guess.
 *
 * This is a **marginal over positions**, which is what makes it a budget on a game's realised rate
 * rather than a ceiling on one position's conditional (see `fastShareCap`).
 */
export function humanFastShare(band: ChessMimicBand): number {
	const prior = CHESSMIMIC_BUCKETS[band]?.bucket_probabilities ?? [];
	let share = 0;
	for (let b = 0; b < prior.length; b++) {
		const upper = CLOCK_BUCKET_BOUNDARIES[b + 1] ?? Number.POSITIVE_INFINITY;
		if (upper <= CM.fastMoveMaxS) share += prior[b] ?? 0;
	}
	return share;
}

/**
 * Budget for the share of this game's plans that may reach the page inside `fastMoveMaxS`:
 * `1 − urgency · (1 − humanFastShare)`.
 *
 * On a full clock that is the band's human rate. It then widens as the clock falls, on the same
 * relative-clock basis as `urgencyFactor`, because a player with a tenth of their clock left really
 * does play most moves in under two seconds.
 *
 * It exists because the model's clock feature is partly a game-phase proxy and it has no base-clock
 * input: a 10+0 game at 480 s reads to it like a 5+3 opening, and it answers with 18.6 % of its mass
 * on bucket 0 and 49.1 % on bucket 1 — measured, real bands — so the page saw 61.6 % of moves inside
 * two seconds there. Why the relative clock and not the phase: a 10+0 at 480 s and a 3+0 at 18 s are
 * both middlegames, and 61 % fast is wrong in the first and right in the second. Phase cannot separate
 * those two; the fraction of the game's own clock still on the board can.
 */
export function fastShareCap(f: Features, band: ChessMimicBand): number {
	return 1 - urgencyFactor(f) * (1 - humanFastShare(band));
}

/**
 * This game's realised rate for the fast channel **this lane added** — adopted `instant` plans that came
 * from a bucket-0 draw on a position §7.4 cannot pre-enter — over every plan so far.
 *
 * Scoped to the addition, not to every fast move on the page, and that scope is the whole point. The
 * shipped bands put ~49 % of their mass on bucket 1, which reaches the page inside two seconds on its
 * own and which this lane has no actuator for; budgeting the *total* against a 21.3 % human prior
 * therefore held the actuator shut for whole games (measured: 17 of 18 real-ONNX cells) and, because
 * the pre-lane build's own in-book `instant` lived in the same channel, made the in-book opening of
 * every time control slower than `2c6b7d3`. Bounding the excess instead leaves the model's baseline
 * alone, keeps the budget's authority, and makes "never slower than pre-lane" structural: the closed
 * path through this gate *is* the pre-lane path.
 *
 * Counted from `state.fastAdded`, which `planMove` increments only for samples it adopts, so
 * `sampleGuarded`'s CV-guard re-draws cannot buy extra chances at it — the bound is on the realised
 * rate and the re-draws land inside it.
 */
export function fastAddedShare(state: Pick<GameTimingState, "fastAdded" | "plannedMs">): number {
	const plans = state.plannedMs.length;
	if (plans === 0) return 0;
	return state.fastAdded / plans;
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

/** What the inference port resolves: the 30 probabilities and the band that produced them. */
export interface InferResult {
	probs: number[];
	band: string;
	/** Inference wall time in the offscreen document, when reported. */
	ms?: number;
}

/** Inference port: resolves the bucket probabilities, or `null` on failure. */
export type InferPort = (inputs: ChessMimicInputs) => Promise<InferResult | null>;

export interface ChessMimicHeadOptions {
	infer: InferPort;
	fallback: DistributionHead;
	budgetMs?: number;
	temperature?: number;
}

interface CachedDistribution {
	fen: string;
	inputs: ChessMimicInputs;
	band: ChessMimicBand;
	probs: number[];
}

function withBudget<T>(p: Promise<T | null>, budgetMs: number): Promise<T | null> {
	return new Promise((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			resolve(null);
		}, budgetMs);
		p.then(
			(v) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(null);
			}
		);
	});
}

export class ChessMimicHead implements DistributionHead {
	readonly id = "chessmimic" as const;
	private readonly infer: InferPort;
	private readonly fallback: DistributionHead;
	private readonly budgetMs: number;
	private readonly temperature: number;
	private cache: CachedDistribution | null = null;
	private lastFailure: string | null = null;
	/** Bumped by every `prepare`/`reset`; a stale inference result never overwrites a newer cache. */
	private generation = 0;

	constructor(options: ChessMimicHeadOptions) {
		this.infer = options.infer;
		this.fallback = options.fallback;
		this.budgetMs = options.budgetMs ?? CM.inferenceBudgetMs;
		this.temperature = options.temperature ?? CM.temperature;
	}

	/** Drop the per-game cache and invalidate any in-flight inference (`startGame`). */
	reset(): void {
		this.generation++;
		this.cache = null;
		this.lastFailure = null;
	}

	/** Issue inference for `ctx` (called as soon as the opponent's move arrives); resolves when cached. */
	async prepare(ctx: TimingContext): Promise<void> {
		const gen = ++this.generation;
		this.cache = null;
		let inputs: ChessMimicInputs;
		try {
			inputs = buildInputs(ctx);
		} catch (e) {
			this.lastFailure = `inputs: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		const result = await withBudget(
			Promise.resolve().then(() => this.infer(inputs)),
			this.budgetMs
		);
		if (gen !== this.generation) return;
		if (!result) {
			this.lastFailure = `timeout/null after ${this.budgetMs} ms`;
			return;
		}
		if (!Array.isArray(result.probs) || result.probs.length !== CM.nBuckets) {
			this.lastFailure = `bad shape ${Array.isArray(result.probs) ? result.probs.length : "?"}`;
			return;
		}
		if (!isRegisteredBand(result.band)) {
			this.lastFailure = `bad band ${result.band}`;
			return;
		}
		this.lastFailure = null;
		this.cache = { fen: ctx.fen, inputs, band: result.band, probs: result.probs };
	}

	private cached(st: Pick<GameTimingState, "fen">): CachedDistribution | null {
		return this.cache && this.cache.fen === st.fen ? this.cache : null;
	}

	median(f: Features, p: Persona, st: GameTimingState, allocSec: number): number {
		const c = this.cached(st);
		if (!c) return this.fallback.median(f, p, st, allocSec);
		return distributionMedianSec(c.band, c.probs) * Math.exp(p.s_game);
	}

	sample(f: Features, p: Persona, st: GameTimingState, rng: Rng, allocSec: number): HeadSample {
		const c = this.cached(st);
		if (!c) {
			const s = this.fallback.sample(f, p, st, rng, allocSec);
			s.why.unshift(
				`chessmimic: fallback to ${this.fallback.id} (${this.lastFailure ?? "not prepared"})`
			);
			return s;
		}
		const mask = bucketMask(c.inputs.playerClockS, c.inputs.incrementS);
		let bucket = sampleBucket(c.probs, mask, this.temperature, rng);
		const why = [`chessmimic band=${c.band} bucket ${bucket} p=${(c.probs[bucket] ?? 0).toFixed(3)}`];
		// Bucket 0 is the model saying "this move took under a second". That is a statement about the
		// *pace*, so it answers `instant` whatever the position is; only the premove branch on top of it
		// is gated on §7.4 eligibility, because a premove is entered before the opponent has replied and
		// a move that cannot be predicted cannot be pre-entered.
		//
		// Until 2026-09-10 an ineligible bucket-0 draw was discarded and re-drawn from buckets ≥ 1.
		// Measured on the real ONNX bands: the shipped head produced 0 instant-mode plans in 2000 against
		// 222 for the v1 fallback — the model's entire fast tail was thrown away on every position that
		// was not a recapture, a book move, a ponder hit or the only legal move. The owner asked about
		// exactly that on 2026-09-09 ("the bot never is able to come up with the move nearly instantly");
		// we were causing it.
		//
		// What bounds it is `fastShareCap` against this game's *realised* page-level fast rate, not a
		// per-position ceiling: while the game is inside its budget the model's own conditional is
		// honoured, and once the game has sent more fast moves to the page than a human would, the
		// channel closes until it has not. Over the budget the draw falls back to the next affordable
		// bucket — which is what this branch did for *every* draw before 2026-09-10.
		if (bucket === 0) {
			if (f.premove_eligible) {
				const pPre = sigmoid(premoveLogit(f, p, st.knobs));
				if (rng.next() < pPre)
					return {
						tSec: rng.next() * TIMING_CONSTANTS.premove.maxS,
						mode: "premove",
						why: [...why, `bucket 0 → premove p=${pPre.toFixed(2)}`],
					};
				// §7.4-eligible and the premove roll missed: `instant`, ungated, exactly as `2c6b7d3`
				// did. This is NOT an exemption bolted on — it is the pre-lane path, and leaving it alone
				// is what makes "never slower than pre-lane" hold in the in-book opening, where round 4's
				// total-scoped budget made 15 of 60 cells slower than the build the owner played.
				return {
					tSec: this.instantSec(c.band, rng),
					mode: "instant",
					why: [...why, "bucket 0 → instant (premove-eligible, as pre-lane)"],
				};
			}
			// The channel this lane added: a sub-second draw on a position no premove can cover. Budgeted
			// against the band's human fast rate, measured over this game's adopted plans. Over budget the
			// draw falls back to the next affordable bucket — which is what this branch did for *every*
			// draw before 2026-09-10, so the closed path is the pre-lane path and cannot be slower.
			const realised = fastAddedShare(st);
			const cap = fastShareCap(f, c.band);
			if (realised <= cap)
				return {
					tSec: this.instantSec(c.band, rng),
					mode: "instant",
					addedFast: true,
					why: [...why, `bucket 0 → instant (added ${realised.toFixed(2)} ≤ budget ${cap.toFixed(2)})`],
				};
			const rest = mask.map((m, b) => m && b > 0);
			const again = sampleBucket(c.probs, rest, this.temperature, rng);
			if (again === 0)
				return {
					tSec: this.instantSec(c.band, rng),
					addedFast: true,
					mode: "instant",
					why: [...why, "bucket 0 over the fast budget; nothing else affordable → instant"],
				};
			bucket = again;
			why.push(`bucket 0 over the fast budget (${cap.toFixed(2)}) → re-sampled bucket ${bucket}`);
		}
		let t = sampleWithinBucket(c.band, bucket, rng);
		if (!st.freezeEps) {
			const phi = CM.arPhi;
			const sigma = CM.arSigma * st.knobs.sigmaScale;
			st.eps = phi * st.eps + Math.sqrt(1 - phi * phi) * sigma * rng.normal();
		}
		t *= Math.exp(p.s_game + st.eps);
		const median = this.median(f, p, st, allocSec);
		const long = bucket >= CM.longBucketFrom || t > CM.longMedianMultiple * median;
		why.push(`s_game=${p.s_game.toFixed(2)} ε=${st.eps.toFixed(2)}`);
		return { tSec: t, mode: long ? "long" : "normal", why };
	}

	private instantSec(band: ChessMimicBand, rng: Rng): number {
		const I = TIMING_CONSTANTS.instant;
		return clamp(sampleWithinBucket(band, 0, rng), I.minS, I.minS + I.rangeS);
	}
}
