/** The ChessMimic `DistributionHead`: cached inference per position, decoded into a think time. */
import type { ChessMimicBand } from "@core/constants/models";
import type { Rng } from "@core/rng";
import type { TimingModelSource } from "@typedefs/timing";
import {
	bucketMask,
	CHESSMIMIC_BUCKETS,
	clockBucketBoundaries,
	distributionMeanSec,
	distributionMedianSec,
	maskedBucketShare,
	sampleBucket,
	sampleWithinBucket,
} from "../chessmimic-buckets";
import { TIMING_CONSTANTS } from "../constants";
import { sigmoid } from "../distributions";
import { premoveLogit } from "../pressure";
import type {
	DistributionHead,
	Features,
	GameTimingState,
	HeadSample,
	Persona,
	TimingContext,
	TimingPreparation,
} from "../types";
import { isRegisteredBand } from "./bands";
import { type InferPort, withBudget } from "./inference";
import { buildInputs, type ChessMimicInputs } from "./inputs";

const CM = TIMING_CONSTANTS.chessmimic;

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

/** The buckets reachable on the clock the position was prepared with (`player_clock + increment`). */
function maskOf(c: CachedDistribution): readonly boolean[] {
	return bucketMask(c.inputs.playerClockS, c.inputs.incrementS, c.band);
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
	async prepare(ctx: TimingContext, options?: TimingPreparation): Promise<void> {
		const gen = ++this.generation;
		this.cache = null;
		let inputs: ChessMimicInputs;
		try {
			inputs = buildInputs(ctx);
		} catch (e) {
			this.lastFailure = `inputs: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		const budgetMs = options?.budgetMs ?? this.budgetMs;
		const result = await withBudget(
			Promise.resolve().then(() => (options?.signal?.aborted ? null : this.infer(inputs, options))),
			budgetMs,
			options?.signal
		);
		if (gen !== this.generation) return;
		if (!result || options?.signal?.aborted) {
			this.lastFailure = options?.signal?.aborted
				? "search preparation ended before inference was ready"
				: `timeout/null after ${budgetMs} ms`;
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
		if (result.probs.some((p) => !Number.isFinite(p) || p < 0) || !result.probs.some((p) => p > 0)) {
			this.lastFailure = "invalid probability distribution";
			return;
		}
		this.lastFailure = null;
		this.cache = { fen: ctx.fen, inputs, band: result.band, probs: result.probs };
	}

	private cached(st: Pick<GameTimingState, "fen">): CachedDistribution | null {
		return this.cache && this.cache.fen === st.fen ? this.cache : null;
	}

	diagnostics(fen: string): TimingModelSource {
		const cached = this.cached({ fen });
		return cached
			? { head: this.id, band: cached.band }
			: {
					head: this.fallback.id,
					requestedHead: this.id,
					fallbackReason: this.lastFailure ?? "not prepared",
				};
	}

	/** The masked, temperature-adjusted distribution used by the sampler. */
	private shaped(c: CachedDistribution, _f: Features): readonly number[] {
		const mask = maskOf(c);
		return c.probs.map((p, i) => (mask[i] ? p ** (1 / this.temperature) : 0));
	}

	median(f: Features, p: Persona, st: GameTimingState, allocSec: number): number {
		const c = this.cached(st);
		if (!c) return this.fallback.median(f, p, st, allocSec);
		return distributionMedianSec(c.band, this.shaped(c, f)) * Math.exp(p.s_game);
	}

	mean(f: Features, p: Persona, st: GameTimingState, allocSec: number): number {
		const c = this.cached(st);
		if (!c)
			return this.fallback.mean?.(f, p, st, allocSec) ?? this.fallback.median(f, p, st, allocSec);
		const expected = distributionMeanSec(c.band, c.probs, maskOf(c), this.temperature);
		const sigma = CM.arSigma * st.knobs.sigmaScale;
		const table = CHESSMIMIC_BUCKETS[c.band].bucket_empirical_distributions[0]?.distribution ?? {};
		const tableTotal = Object.values(table).reduce((sum, weight) => sum + weight, 0);
		const underOne = tableTotal > 0 ? (table["0"] ?? 0) / tableTotal : 0;
		const fastShare = underOne * maskedBucketShare(c.probs, maskOf(c), this.temperature, 0);
		const pPre = f.premove_eligible ? sigmoid(premoveLogit(f, p, st.knobs)) : 0;
		const fastMean = (pPre * TIMING_CONSTANTS.premove.maxS) / 2 + (1 - pPre) * this.instantSec(0.5);
		// Fast samples are clock windows, without the body persona/AR multiplier. The novice
		// bucket mixes seconds 0 and 1; only its actual subsecond mass takes this fast path.
		return (
			(expected - fastShare * 0.5) * Math.exp(p.s_game + (sigma * sigma) / 2) + fastShare * fastMean
		);
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
		const mask = maskOf(c);
		const bucket = sampleBucket(c.probs, mask, this.temperature, rng);
		const why = [`chessmimic band=${c.band} bucket ${bucket} p=${(c.probs[bucket] ?? 0).toFixed(3)}`];
		const wideFastSample =
			bucket === 0 && (clockBucketBoundaries(c.band)[1] ?? 1) > 1
				? sampleWithinBucket(c.band, bucket, rng)
				: null;
		if (bucket === 0 && (wideFastSample === null || wideFastSample < 1)) {
			const pPre = f.premove_eligible ? sigmoid(premoveLogit(f, p, st.knobs)) : 0;
			if (rng.next() < pPre)
				return {
					tSec: rng.next() * TIMING_CONSTANTS.premove.maxS,
					mode: "premove",
					opponentClockConditioned: true,
					why: [...why, `bucket 0 → premove p=${pPre.toFixed(2)}`],
				};
			return {
				tSec: this.instantSec(wideFastSample ?? sampleWithinBucket(c.band, bucket, rng)),
				mode: "instant",
				includesExecution: true,
				opponentClockConditioned: true,
				why: [...why, "bucket 0 → instant"],
			};
		}
		let t = wideFastSample ?? sampleWithinBucket(c.band, bucket, rng);
		if (!st.freezeEps) {
			const phi = CM.arPhi;
			const sigma = CM.arSigma * st.knobs.sigmaScale;
			st.eps = phi * st.eps + Math.sqrt(1 - phi * phi) * sigma * rng.normal();
		}
		t *= Math.exp(p.s_game + st.eps);
		const median = this.median(f, p, st, allocSec);
		const long = bucket >= CM.longBucketFrom || t > CM.longMedianMultiple * median;
		why.push(`s_game=${p.s_game.toFixed(2)} ε=${st.eps.toFixed(2)}`);
		return {
			tSec: t,
			mode: long ? "long" : "normal",
			includesExecution: true,
			opponentClockConditioned: true,
			why,
		};
	}

	private instantSec(sample: number): number {
		// Clock labels include the hand. Condition the subsecond draw on the physical support
		// before planning: U(0,1) -> U(orientation floor + motor floor,1), without a floor atom.
		const floor = (TIMING_CONSTANTS.orientation.minMs + TIMING_CONSTANTS.motor.minMotorMs) / 1000;
		return floor + (1 - floor) * sample;
	}
}
