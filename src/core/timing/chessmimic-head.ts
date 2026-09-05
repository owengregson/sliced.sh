/**
 * ChessMimic timing head (§8.4b item 6, Appendix J §B). This file holds the
 * TypeScript preprocessing for the exported ONNX clock model — the
 * searchless_chess FEN tokeniser (77 tokens + ChessMimic's class token = 78),
 * the 1 968-entry UCI move vocabulary, the last-12-move window, the per-band
 * scaler constants and the virtual clock for clockless games — plus the
 * decoding of the 30 bucket probabilities: `player_clock + increment` mask,
 * temperature-scaled bucket draw, within-bucket continuous draw, persona
 * `s_game` shift and the AR(1) residual on top.
 *
 * Inference itself is an injected port (`infer`), normally the offscreen
 * `timing-inference.ts` over the engine port; it runs under a 100 ms budget
 * and the v1 head answers on timeout, load failure or an unprepared position.
 *
 * Reconciliation points for Task 34 (bit-for-bit fixture): the shared
 * `PAD_TOKEN` (32) for the move window, per-square queen-then-knight ordering
 * of the regular moves, and the placeholder scaler / per-bucket samples below.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
import { sigmoid, uniform } from "./distributions";
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

// ---------------------------------------------------------------------------
// FEN tokeniser (google-deepmind/searchless_chess `tokenizer.py`, + CLASS_TOKEN)
// ---------------------------------------------------------------------------

export const FEN_CHARACTERS = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"a",
	"b",
	"c",
	"d",
	"e",
	"f",
	"g",
	"h",
	"p",
	"n",
	"r",
	"k",
	"q",
	"P",
	"B",
	"N",
	"R",
	"Q",
	"K",
	"w",
	".",
] as const;

const CHAR_INDEX = new Map<string, number>(FEN_CHARACTERS.map((c, i) => [c, i]));
const DOT = CHAR_INDEX.get(".") ?? 30;

/** 31 characters + class + pad. */
export const INPUT_VOCAB_SIZE = FEN_CHARACTERS.length + 2;
export const CLASS_TOKEN = INPUT_VOCAB_SIZE - 2;
export const PAD_TOKEN = INPUT_VOCAB_SIZE - 1;
export const FEN_SEQUENCE_LENGTH = CM.fenTokens;

function charToken(ch: string): number {
	const id = CHAR_INDEX.get(ch);
	if (id === undefined) throw new RangeError(`chessmimic tokeniser: unknown character "${ch}"`);
	return id;
}

/** `[side][64 board squares][castling ×4][ep ×2][halfmove ×3][fullmove ×3][CLASS]` = 78 tokens. */
export function tokenizeFen(fen: string): number[] {
	const [board = "", side = "w", castling = "-", ep = "-", half = "0", full = "1"] = fen
		.trim()
		.split(/\s+/);
	const out: number[] = [];
	for (const ch of side + board.replace(/\//g, "")) {
		if (ch >= "1" && ch <= "8") for (let i = 0; i < Number(ch); i++) out.push(DOT);
		else out.push(charToken(ch));
	}
	if (castling === "-") out.push(DOT, DOT, DOT, DOT);
	else {
		for (const ch of castling) out.push(charToken(ch));
		for (let i = castling.length; i < 4; i++) out.push(DOT);
	}
	if (ep === "-") out.push(DOT, DOT);
	else for (const ch of ep) out.push(charToken(ch));
	for (const field of [half, full]) {
		const padded = field + ".".repeat(Math.max(0, 3 - field.length));
		for (const ch of padded) out.push(charToken(ch));
	}
	out.push(CLASS_TOKEN);
	if (out.length !== FEN_SEQUENCE_LENGTH)
		throw new RangeError(`chessmimic tokeniser: ${out.length} tokens for "${fen}"`);
	return out;
}

// ---------------------------------------------------------------------------
// UCI move vocabulary (searchless_chess `_compute_all_possible_actions`)
// ---------------------------------------------------------------------------

const FILES = "abcdefgh";

function squareName(i: number): string {
	return `${FILES.charAt(i % 8)}${Math.floor(i / 8) + 1}`;
}

/**
 * For every square (a1 = 0 … h8 = 63, ascending): the queen's attack squares
 * on an empty board in ascending order, then the knight's; then the
 * promotions (ranks 2→1 and 7→8, files a…h, straight / left capture / right
 * capture, pieces q r b n). 1 792 + 176 = 1 968 entries.
 */
export function buildMoveVocabulary(): string[] {
	const moves: string[] = [];
	for (let s = 0; s < 64; s++) {
		const f = s % 8;
		const r = Math.floor(s / 8);
		const queen: number[] = [];
		const knight: number[] = [];
		for (let t = 0; t < 64; t++) {
			if (t === s) continue;
			const tf = t % 8;
			const tr = Math.floor(t / 8);
			const df = Math.abs(tf - f);
			const dr = Math.abs(tr - r);
			if (tf === f || tr === r || df === dr) queen.push(t);
			if ((df === 1 && dr === 2) || (df === 2 && dr === 1)) knight.push(t);
		}
		for (const t of [...queen, ...knight]) moves.push(squareName(s) + squareName(t));
	}
	for (const [rank, next] of [
		["2", "1"],
		["7", "8"],
	] as const) {
		for (let i = 0; i < 8; i++) {
			const file = FILES.charAt(i);
			const targets = [file];
			if (i > 0) targets.push(FILES.charAt(i - 1));
			if (i < 7) targets.push(FILES.charAt(i + 1));
			for (const tf of targets)
				for (const piece of ["q", "r", "b", "n"]) moves.push(`${file}${rank}${tf}${next}${piece}`);
		}
	}
	if (moves.length !== CM.moveVocabSize)
		throw new RangeError(
			`chessmimic vocabulary: ${moves.length} entries, expected ${CM.moveVocabSize}`
		);
	return moves;
}

export const MOVE_VOCABULARY: readonly string[] = buildMoveVocabulary();
export const MOVE_TO_ACTION: ReadonlyMap<string, number> = new Map(
	MOVE_VOCABULARY.map((m, i) => [m, i])
);

/** Last 12 moves, oldest → newest, left-padded with `PAD_TOKEN`; unknown moves also pad. */
export function encodeRecentMoves(moves: readonly string[]): number[] {
	const n = CM.recentMoves;
	const window = moves.slice(-n);
	const out = new Array<number>(n).fill(PAD_TOKEN);
	window.forEach((m, i) => {
		out[n - window.length + i] = MOVE_TO_ACTION.get(m) ?? PAD_TOKEN;
	});
	return out;
}

// ---------------------------------------------------------------------------
// Bands and scalers
// ---------------------------------------------------------------------------

export type ChessMimicBand = (typeof CM.bands)[number];
export const CHESSMIMIC_BANDS: readonly ChessMimicBand[] = CM.bands;

export interface Scaler {
	mean: number;
	std: number;
}

/** Shape of `scalers.pkl` unpickled per band (Appendix J §B item 2). */
export interface BandScalers {
	rating: Scaler;
	log_player_clock: Scaler;
	log_opponent_clock: Scaler;
	log_increment: Scaler;
	/** `"placeholder"` until Task 34 embeds the real per-band constants. */
	source: "placeholder" | "chessmimic";
}

function placeholderScalers(band: ChessMimicBand): BandScalers {
	const [lo = 1500, hi = 1600] = band.split("_").map(Number);
	return {
		rating: { mean: (lo + hi) / 2, std: (hi - lo) / Math.sqrt(12) },
		log_player_clock: { mean: Math.log(UNTIMED.clockS / 2 + 1), std: 1 },
		log_opponent_clock: { mean: Math.log(UNTIMED.clockS / 2 + 1), std: 1 },
		log_increment: { mean: Math.log(1 + UNTIMED.incS), std: 1 },
		source: "placeholder",
	};
}

/** Per-band scaler constants; JSON-shaped so Task 34 can drop in the exported values. */
export const BAND_SCALERS: Readonly<Record<ChessMimicBand, BandScalers>> = Object.freeze({
	"1200_1300": placeholderScalers("1200_1300"),
	"1500_1600": placeholderScalers("1500_1600"),
	"1800_1900": placeholderScalers("1800_1900"),
});

function bandCentre(band: ChessMimicBand): number {
	const [lo = 0, hi = 0] = band.split("_").map(Number);
	return (lo + hi) / 2;
}

/** Nearest shipped band to the target Elo (ties → the lower band). */
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

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ChessMimicInputs {
	band: ChessMimicBand;
	/** 12 move tokens (left-padded). */
	moveTokens: number[];
	/** 78 FEN tokens. */
	fenTokens: number[];
	/** `[moves, rating, clock, board]` = 92 once the two scalar tokens are embedded. */
	sequenceLength: number;
	scaledRating: number;
	/** `[log(player+1), log(opp+1), log(inc+1)]` standardised with the band scalers. */
	clockFeatures: [number, number, number];
	playerClockS: number;
	opponentClockS: number;
	incrementS: number;
}

function standardise(x: number, s: Scaler): number {
	return (x - s.mean) / (s.std || 1);
}

/** Build the model inputs from a `TimingContext`; clockless games get the fixed virtual clock. */
export function buildInputs(ctx: TimingContext): ChessMimicInputs {
	const untimed = tcClass(ctx.baseSec, ctx.incSec) === "untimed";
	const playerClockS = untimed ? UNTIMED.clockS : Math.max(0, ctx.myClockMs / 1000);
	const opponentClockS = untimed ? UNTIMED.clockS : Math.max(0, ctx.oppClockMs / 1000);
	const incrementS = untimed ? UNTIMED.incS : ctx.incSec;
	const band = selectBand(ctx.targetElo);
	const s = BAND_SCALERS[band];
	const moveTokens = encodeRecentMoves(ctx.moves);
	const fenTokens = tokenizeFen(ctx.fen);
	// `[moves, rating, clock, board]`: the two scalar tokens are embedded by the model.
	const sequenceLength = moveTokens.length + 2 + fenTokens.length;
	if (sequenceLength !== CM.sequenceLength)
		throw new RangeError(
			`chessmimic inputs: ${sequenceLength} tokens, expected ${CM.sequenceLength}`
		);
	return {
		band,
		moveTokens,
		fenTokens,
		sequenceLength,
		scaledRating: standardise(ctx.targetElo, s.rating),
		clockFeatures: [
			standardise(Math.log(playerClockS + 1), s.log_player_clock),
			standardise(Math.log(opponentClockS + 1), s.log_opponent_clock),
			standardise(Math.log(incrementS + 1), s.log_increment),
		],
		playerClockS,
		opponentClockS,
		incrementS,
	};
}

// ---------------------------------------------------------------------------
// Buckets and decoding
// ---------------------------------------------------------------------------

/** `clock_buckets.json` boundaries: 1-s buckets to 27 s, then [27,32), [32,40), [40,∞). */
export const CLOCK_BUCKET_BOUNDARIES: readonly number[] = Object.freeze([
	...Array.from({ length: 28 }, (_, i) => i),
	32,
	40,
	Number.POSITIVE_INFINITY,
]);

export function bucketIndexOf(seconds: number): number {
	for (let b = CM.nBuckets - 1; b >= 0; b--)
		if (seconds >= (CLOCK_BUCKET_BOUNDARIES[b] ?? 0)) return b;
	return 0;
}

/** Buckets whose lower edge is within `player_clock + increment`; bucket 0 always valid. */
export function bucketMask(playerClockS: number, incrementS: number): boolean[] {
	const maxValid = bucketIndexOf(Math.max(0, playerClockS + incrementS));
	return Array.from({ length: CM.nBuckets }, (_, b) => b === 0 || b <= maxValid);
}

/** Temperature-scaled draw over the valid buckets; bucket 0 when nothing else has mass. */
export function sampleBucket(
	probs: readonly number[],
	mask: readonly boolean[],
	temperature: number,
	rng: Rng
): number {
	const T = Math.max(1e-3, temperature);
	const weights: number[] = [];
	const items: number[] = [];
	let total = 0;
	for (let b = 0; b < CM.nBuckets; b++) {
		const p = probs[b] ?? 0;
		if (!mask[b] || !(p > 0)) continue;
		const w = p ** (1 / T);
		weights.push(w);
		items.push(b);
		total += w;
	}
	if (items.length === 0 || !(total > 0)) return 0;
	return rng.weighted(items, weights);
}

/**
 * Continuous value inside the bucket. Placeholder: uniform within the edges
 * (the open bucket spans `openBucketSpanS`) until Task 34 ships the per-bucket
 * empirical samples from `clock_buckets.json`.
 */
export function sampleWithinBucket(bucket: number, rng: Rng): number {
	const lo = CLOCK_BUCKET_BOUNDARIES[bucket] ?? 0;
	const hiEdge = CLOCK_BUCKET_BOUNDARIES[bucket + 1] ?? Number.POSITIVE_INFINITY;
	const hi = Number.isFinite(hiEdge) ? hiEdge : lo + CM.openBucketSpanS;
	return uniform(rng, lo, hi);
}

function bucketMidpoint(bucket: number): number {
	const lo = CLOCK_BUCKET_BOUNDARIES[bucket] ?? 0;
	const hiEdge = CLOCK_BUCKET_BOUNDARIES[bucket + 1] ?? Number.POSITIVE_INFINITY;
	const hi = Number.isFinite(hiEdge) ? hiEdge : lo + CM.openBucketSpanS;
	return (lo + hi) / 2;
}

/** Median of the bucket distribution (bucket midpoint at the 50 % mass). */
export function distributionMedianSec(probs: readonly number[]): number {
	let total = 0;
	for (const p of probs) total += p;
	if (!(total > 0)) return bucketMidpoint(0);
	let acc = 0;
	for (let b = 0; b < CM.nBuckets; b++) {
		acc += (probs[b] ?? 0) / total;
		if (acc >= 0.5) return bucketMidpoint(b);
	}
	return bucketMidpoint(CM.nBuckets - 1);
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

/** Inference port: resolves the 30 bucket probabilities, or `null` on failure. */
export type InferPort = (inputs: ChessMimicInputs) => Promise<number[] | null>;

export interface ChessMimicHeadOptions {
	infer: InferPort;
	fallback: DistributionHead;
	budgetMs?: number;
	temperature?: number;
}

interface CachedDistribution {
	fen: string;
	inputs: ChessMimicInputs;
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

	/** Issue inference for `ctx` (called as soon as the opponent's move arrives). */
	/** Drop the per-game cache (`startGame`). */
	reset(): void {
		this.generation++;
		this.cache = null;
		this.lastFailure = null;
	}

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
		const probs = await withBudget(
			Promise.resolve().then(() => this.infer(inputs)),
			this.budgetMs
		);
		if (gen !== this.generation) return;
		if (!probs || probs.length !== CM.nBuckets) {
			this.lastFailure = probs
				? `bad shape ${probs.length}`
				: `timeout/null after ${this.budgetMs} ms`;
			return;
		}
		this.lastFailure = null;
		this.cache = { fen: ctx.fen, inputs, probs };
	}

	private cached(st: Pick<GameTimingState, "fen">): CachedDistribution | null {
		return this.cache && this.cache.fen === st.fen ? this.cache : null;
	}

	median(f: Features, p: Persona, st: GameTimingState, allocSec: number): number {
		const c = this.cached(st);
		if (!c) return this.fallback.median(f, p, st, allocSec);
		return distributionMedianSec(c.probs) * Math.exp(p.s_game);
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
		const why = [
			`chessmimic band=${c.inputs.band} bucket ${bucket} p=${(c.probs[bucket] ?? 0).toFixed(3)}`,
		];
		if (bucket === 0) {
			if (f.premove_eligible) {
				const pPre = sigmoid(premoveLogit(f, p, st.knobs));
				if (rng.next() < pPre)
					return {
						tSec: rng.next() * TIMING_CONSTANTS.premove.maxS,
						mode: "premove",
						why: [...why, `bucket 0 → premove p=${pPre.toFixed(2)}`],
					};
				return { tSec: this.instantSec(rng), mode: "instant", why: [...why, "bucket 0 → instant"] };
			}
			const rest = mask.map((m, b) => m && b > 0);
			const again = sampleBucket(c.probs, rest, this.temperature, rng);
			if (again === 0)
				return {
					tSec: this.instantSec(rng),
					mode: "instant",
					why: [...why, "bucket 0 not eligible; nothing else affordable → instant"],
				};
			bucket = again;
			why.push(`bucket 0 not premove-eligible → re-sampled bucket ${bucket}`);
		}
		let t = sampleWithinBucket(bucket, rng);
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

	private instantSec(rng: Rng): number {
		const I = TIMING_CONSTANTS.instant;
		return clamp(sampleWithinBucket(0, rng), I.minS, I.minS + I.rangeS);
	}
}
