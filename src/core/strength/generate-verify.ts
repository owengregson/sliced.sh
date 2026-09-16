/**
 * Recognition-preserving Maia verification (2026-09-16).
 *
 * Through the ordinary range (effective Elo <= 2800), recognition proposes twice independently
 * from Maia; a logistic comparison uses only available shallow evidence. Equal or missing
 * evidence leaves the population distribution unchanged. The exact distribution is available
 * for fidelity accounting without Monte Carlo in the service worker.
 *
 * The existing distinct-candidate / Gaussian comparison is retained in the upper verification
 * band and as an explicit offline baseline. It must not be described as running Maia unchanged:
 * choosing a noisy argmax from distinct proposals can amplify unlikely moves even at equal cp.
 * See docs/research/maia-recognition-verification-2026-09-16.md for evidence and limitations.
 */

import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import { upperVerificationProgress } from "@core/policy/maia-size";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { eloRamp, sigmaFor } from "./elo-map";

/** One survivor of the rails, as the Maia branch of `selectMove` hands it in. */
export interface GvCandidate {
	uci: string;
	/** Maia's probability of the move (raw, untempered). */
	p: number;
	/** The deep referee's score for the move, side-to-move POV cp (`cpEffective`). */
	deepCp: number;
	/** The same move's score in the shallow frame at the human depth, when that frame ranked it. */
	shallowCp?: number;
}

export interface GvInput {
	/** The scored candidates that survived the rails (mated, hangs, loss cap). */
	survivors: readonly GvCandidate[];
	/** Effective Elo the move is judged at. */
	E: number;
	/** The depth `shallowCp` values were captured at; absent when no shallow frame exists. */
	shallowDepth?: number;
	rng: Rng;
	/** Per-call override of `GENERATE_VERIFY.enabled`. */
	enabled?: boolean;
}

/** One row of the verification table, for the rationale and the meters. */
export interface GvConsidered {
	uci: string;
	p: number;
	/** Shallow score; 0 when unavailable in recognition mode. Upper mode may use deep cp. */
	cp: number;
	/** Compared score. Recognition mode keeps cp; upper mode adds Gaussian perception noise. */
	score: number;
	/** True when finite shallow evidence exists; false is unverified, never synthetic evidence. */
	verified: boolean;
}

export interface GvResult {
	uci: string;
	/** Candidates drawn (1 on the intuition path). */
	k: number;
	/** True when the move was played on recognition alone. */
	intuition: boolean;
	/** The depth the candidates were verified at; 0 when no shallow frame existed. */
	verifyDepth: number;
	/** The candidates in draw order with their scores. */
	considered: GvConsidered[];
	rationale: string[];
}

function fmt(n: number, digits = 3): string {
	return Number(n.toFixed(digits)).toString();
}

/** `[x, y]` knots: flat outside, linear between. */
function interpolateKnots(x: number, knots: ReadonlyArray<readonly [number, number]>): number {
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (first === undefined || last === undefined) return 0;
	if (x <= first[0]) return first[1];
	if (x >= last[0]) return last[1];
	for (let i = 1; i < knots.length; i++) {
		const lo = knots[i - 1];
		const hi = knots[i];
		if (lo === undefined || hi === undefined) continue;
		if (x <= hi[0]) return lo[1] + ((x - lo[0]) / (hi[0] - lo[0])) * (hi[1] - lo[1]);
	}
	return last[1];
}

/** The un-jittered `k(E)`: the `GENERATE_VERIFY.candidates` knots interpolated and rounded. */
export function candidateBase(E: number): number {
	return Math.round(interpolateKnots(E, GV.candidates.knots));
}

/** `k(E)` for one move: `candidateBase(E) ± jitter`, clamped to `[min, max]`. Consumes one draw. */
export function candidateCount(E: number, rng: Rng): number {
	const { jitter, min, max } = GV.candidates;
	return clamp(candidateBase(E) + rng.int(-jitter, jitter), min, max);
}

/** `pIntuition(E)`: the probability the move is played on recognition alone. */
export function intuitionProb(E: number): number {
	const { loElo, loProb, hiElo, hiProb } = GV.intuition;
	const ordinary = eloRamp(E, loElo, loProb, hiElo, hiProb);
	return ordinary + upperVerificationProgress(E) * (GV.intuition.upperProb - ordinary);
}

/** Above 2800, progressively include the same bounded search's deeper evidence. */
export function verificationCp(candidate: GvCandidate, E: number): number {
	const shallow = candidate.shallowCp ?? candidate.deepCp;
	return shallow + upperVerificationProgress(E) * (candidate.deepCp - shallow);
}

/**
 * The perception noise on the verified (shallow) scores: `max(sigmaFor(E), floor(E))` with the
 * `GENERATE_VERIFY.verifySigmaFloorCp` knots — `sigmaFor` was calibrated against deep scores, and
 * a score read at the human depth carries the shallow frame's own error on top (HvS §5.4).
 */
export function verifySigmaFor(E: number): number {
	return Math.max(sigmaFor(E), interpolateKnots(E, GV.verifySigmaFloorCp));
}

/** Draw `k` distinct candidates without replacement, each in proportion to its Maia mass. */
function drawDistinct(pool: readonly GvCandidate[], k: number, rng: Rng): GvCandidate[] {
	const remaining = [...pool];
	const drawn: GvCandidate[] = [];
	while (drawn.length < k && remaining.length > 0) {
		const pick = rng.weighted(
			remaining,
			remaining.map((c) => c.p)
		);
		drawn.push(pick);
		remaining.splice(remaining.indexOf(pick), 1);
	}
	return drawn;
}

/**
 * Generate-and-verify over the survivors, or `null` when the path is disabled or fewer than two
 * survivors carry Maia mass (the caller runs the plain draw). Draw order from `rng`: the
 * intuition coin, then (unless intuition) the `k` jitter, the `k` weighted draws, and one normal
 * per candidate.
 */
export function distinctCandidateVerification(input: GvInput): GvResult | null {
	if (!(input.enabled ?? GV.enabled)) return null;
	const pool = input.survivors.filter((c) => c.p > 0);
	if (pool.length < GV.candidates.min) return null;
	const { E, rng } = input;
	const pIntuition = intuitionProb(E);
	const intuition = rng.chance(pIntuition);
	const k = intuition ? 1 : Math.min(candidateCount(E, rng), pool.length);
	const drawn = drawDistinct(pool, k, rng);
	const sigma = verifySigmaFor(E);
	const verifyDepth = input.shallowDepth ?? 0;
	const considered: GvConsidered[] = drawn.map((c) => {
		const verified = c.shallowCp !== undefined;
		const cp = verificationCp(c, E);
		const score = intuition ? cp : cp + rng.normal(0, sigma);
		return { uci: c.uci, p: c.p, cp, score, verified };
	});
	let best = considered[0];
	if (best === undefined) return null;
	for (const row of considered) if (row.score > best.score) best = row;

	const rationale: string[] = [];
	if (intuition) {
		rationale.push(
			`generate-verify: intuition — played on recognition alone (p=${fmt(pIntuition, 2)} at E, ${pool.length} survivors)`
		);
	} else {
		const unverified = considered.filter((row) => !row.verified).length;
		const frame =
			verifyDepth > 0 ? `verified at depth ${verifyDepth}` : "no shallow frame, deep scores stood in";
		rationale.push(
			`generate-verify: k=${k} of ${pool.length} survivors (pIntuition ${fmt(pIntuition, 2)}), ${frame}, σ=${fmt(sigma, 1)}${unverified > 0 ? `, ${unverified} unverified` : ""}`
		);
		for (const row of considered)
			rationale.push(
				`  ${row.uci} p=${fmt(row.p)} ${row.verified ? "shallow" : "deep"} ${fmt(row.cp, 0)} → ${fmt(row.score, 0)}${row === best ? " ✓" : ""}`
			);
	}
	return { uci: best.uci, k, intuition, verifyDepth, considered, rationale };
}

/** Positive finite policy mass; duplicate roots do not get extra recognition tickets. */
function recognitionPool(survivors: readonly GvCandidate[]): GvCandidate[] {
	const byUci = new Map<string, GvCandidate>();
	for (const c of survivors) {
		if (!Number.isFinite(c.p) || c.p <= 0) continue;
		const previous = byUci.get(c.uci);
		if (previous === undefined || c.p > previous.p) byUci.set(c.uci, c);
	}
	return [...byUci.values()];
}

/** Missing shallow scores supply no comparison evidence, regardless of the deep scores. */
function comparisonProbability(a: GvCandidate, b: GvCandidate, E: number): number {
	if (
		a.shallowCp === undefined ||
		b.shallowCp === undefined ||
		!Number.isFinite(a.shallowCp) ||
		!Number.isFinite(b.shallowCp)
	)
		return 0.5;
	return 1 / (1 + Math.exp((b.shallowCp - a.shallowCp) / verifySigmaFor(E)));
}

/**
 * Exact law of two independent recognition proposals and a noisy shallow comparison, mixed
 * with the existing intuition share. Equal or missing evidence preserves Maia exactly.
 * Familiarity may propose the same move twice; unlike a distinct-candidate tournament this
 * does not force rare moves into consideration. q/p stays in [pIntuition, 2 - pIntuition].
 */
export function recognitionDistribution(
	input: Pick<GvInput, "survivors" | "E">
): Map<string, number> {
	const pool = recognitionPool(input.survivors);
	const total = pool.reduce((sum, c) => sum + c.p, 0);
	const q = new Map(pool.map((c) => [c.uci, c.p / total]));
	const compareShare = 1 - intuitionProb(input.E);
	for (let i = 0; i < pool.length; i++) {
		const a = pool[i];
		if (a === undefined) continue;
		for (let j = i + 1; j < pool.length; j++) {
			const b = pool[j];
			if (b === undefined) continue;
			const transfer =
				compareShare * 2 * (a.p / total) * (b.p / total) * (comparisonProbability(a, b, input.E) - 0.5);
			q.set(a.uci, (q.get(a.uci) ?? 0) + transfer);
			q.set(b.uci, (q.get(b.uci) ?? 0) - transfer);
		}
	}
	return q;
}

/** Two proposals, sampled with replacement; repeated recognition costs no extra comparison. */
function recognitionVerification(input: GvInput): GvResult | null {
	const pool = recognitionPool(input.survivors);
	if (pool.length < GV.candidates.min) return null;
	const { E, rng } = input;
	const intuition = rng.chance(intuitionProb(E));
	const first = rng.weighted(
		pool,
		pool.map((c) => c.p)
	);
	const second = intuition
		? first
		: rng.weighted(
				pool,
				pool.map((c) => c.p)
			);
	const compared = !intuition && first.uci !== second.uci;
	const bothScored = Number.isFinite(first.shallowCp) && Number.isFinite(second.shallowCp);
	const pick =
		compared && bothScored && rng.chance(comparisonProbability(second, first, E)) ? second : first;
	const considered = (compared ? [first, second] : [first]).map((c) => ({
		uci: c.uci,
		p: c.p,
		cp: Number.isFinite(c.shallowCp) ? (c.shallowCp ?? 0) : 0,
		score: Number.isFinite(c.shallowCp) ? (c.shallowCp ?? 0) : 0,
		verified: Number.isFinite(c.shallowCp),
	}));
	const verifyDepth = input.shallowDepth ?? 0;
	const rationale = [
		intuition
			? `generate-verify: intuition — played on recognition alone (p=${fmt(intuitionProb(E), 2)} at E, ${pool.length} survivors)`
			: `generate-verify: recognition proposals ${considered.length} of ${pool.length}, ${compared && bothScored ? `compared at depth ${verifyDepth}` : "recognition retained; no comparable new evidence"}, σ=${fmt(verifySigmaFor(E), 1)}`,
	];
	return { uci: pick.uci, k: considered.length, intuition, verifyDepth, considered, rationale };
}

/** The upper-band path is preserved; ordinary verification keeps recognition mass. */
export function generateAndVerify(input: GvInput): GvResult | null {
	if (!(input.enabled ?? GV.enabled)) return null;
	return upperVerificationProgress(input.E) > 0
		? distinctCandidateVerification(input)
		: recognitionVerification(input);
}

/**
 * The exact ordinary-range distribution, or upper-range empirical law over `samples` runs, that the meters
 * and the harness (§8.2) read. When the path would return `null` the plain draw's distribution
 * (Maia's mass renormalised over the survivors) is returned instead, since that is what would
 * be played. Sums to 1.
 */
export function drawDistribution(
	input: Omit<GvInput, "rng">,
	samples: number,
	rng: Rng
): Map<string, number> {
	if ((input.enabled ?? GV.enabled) && upperVerificationProgress(input.E) === 0)
		return recognitionDistribution(input);
	const q = new Map<string, number>();
	const add = (uci: string, mass: number) => q.set(uci, (q.get(uci) ?? 0) + mass);
	let landed = 0;
	for (let i = 0; i < samples; i++) {
		const result = generateAndVerify({ ...input, rng });
		if (result === null) break;
		add(result.uci, 1);
		landed++;
	}
	if (landed === samples && samples > 0) {
		for (const [uci, n] of q) q.set(uci, n / samples);
		return q;
	}
	q.clear();
	let total = 0;
	for (const c of input.survivors) if (c.p > 0) total += c.p;
	for (const c of input.survivors) if (c.p > 0 && total > 0) add(c.uci, c.p / total);
	return q;
}

/**
 * `KL(q ‖ p)` in nats over `q`'s support: `p` is renormalised over the same keys so the number
 * says how far the draw moved from Maia *among the survivors*. 0 when the wrapper changed
 * nothing; `Infinity` when `q` draws a move Maia gives no mass.
 */
export function gvKl(q: ReadonlyMap<string, number>, p: ReadonlyMap<string, number>): number {
	let qTotal = 0;
	let pTotal = 0;
	for (const [uci, mass] of q) {
		if (mass <= 0) continue;
		qTotal += mass;
		pTotal += p.get(uci) ?? 0;
	}
	if (qTotal <= 0) return 0;
	let kl = 0;
	for (const [uci, mass] of q) {
		if (mass <= 0) continue;
		const qm = mass / qTotal;
		const pm = pTotal > 0 ? (p.get(uci) ?? 0) / pTotal : 0;
		if (pm <= 0) return Number.POSITIVE_INFINITY;
		kl += qm * Math.log(qm / pm);
	}
	return Math.max(0, kl);
}
