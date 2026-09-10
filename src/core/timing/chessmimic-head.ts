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
	distributionMedianSec,
	sampleBucket,
	sampleWithinBucket,
} from "./chessmimic-buckets";
import { bandCentre } from "./chessmimic-scalers";
import { encodeRecentMoves, tokenizeFen } from "./chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "./constants";
import { sigmoid } from "./distributions";
import { tcClass } from "./features";
import { premoveLogit } from "./pressure";
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
		const bucket = sampleBucket(c.probs, mask, this.temperature, rng);
		const why = [`chessmimic band=${c.band} bucket ${bucket} p=${(c.probs[bucket] ?? 0).toFixed(3)}`];
		// Bucket 0 is the model saying "this move took under a second". That is a statement about the
		// *pace*, so it answers `instant` whatever the position is; only the premove branch on top of it
		// is gated on §7.4 eligibility, because a premove is entered before the opponent has replied and
		// a move that cannot be predicted cannot be pre-entered.
		//
		// Until 2026-09-10 an ineligible bucket-0 draw was discarded and re-drawn from buckets ≥ 1.
		// Measured on the real ONNX bands: ≈ 21 % of the mass sits on bucket 0 at a full 3+0 clock, and
		// redistributing all of it upward left the shipped head with 0 instant-mode plans in 2000
		// against 222 for the v1 fallback — the model's entire fast tail was being thrown away on every
		// position that was not a recapture, a book move, a ponder hit or the only legal move. The owner
		// asked about exactly that on 2026-09-09 ("the bot never is able to come up with the move nearly
		// instantly"); we were causing it.
		if (bucket === 0) {
			if (f.premove_eligible) {
				const pPre = sigmoid(premoveLogit(f, p, st.knobs));
				if (rng.next() < pPre)
					return {
						tSec: rng.next() * TIMING_CONSTANTS.premove.maxS,
						mode: "premove",
						why: [...why, `bucket 0 → premove p=${pPre.toFixed(2)}`],
					};
			}
			return {
				tSec: this.instantSec(c.band, rng),
				mode: "instant",
				why: [...why, "bucket 0 → instant"],
			};
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
