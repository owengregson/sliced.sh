/**
 * Generate-and-verify move selection below `MAIA.eloMax` (H3 + H4 of
 * `docs/research/human-move-selection-ideas-2026-09-13.md`, 2026-09-13).
 *
 * The plain Maia draw picks one move from a smooth distribution. A human (HvS §2.3, §5.2, §5.3,
 * §10.1 steps 3–7) does something else: recognition proposes a *few* candidates, calculation
 * checks them at the depth the rating can manage, and the best-looking one is played. Three
 * stages, each reusing a number the selector already has:
 *
 * 1. **Generate** — draw `k(E)` distinct candidates *without replacement* from Maia's
 *    distribution over the survivors of the rails (no re-weighting, `T = 1`: the models run as
 *    advertised). With probability `pIntuition(E)` the move is played on recognition alone
 *    (`k = 1`, no verification).
 * 2. **Verify** — score each candidate at the *human* depth: the same search's complete MultiPV
 *    frame at `humanDepth(E)` (`SelectionContext.shallowLines`). A candidate the shallow frame did
 *    not rank falls back to its deep referee score and is marked unverified.
 * 3. **Compare** — play the argmax of shallow cp + `N(0, σ_verify(E))`: the §7.2 step 3 perception
 *    noise (`sigmaFor`) floored by `GENERATE_VERIFY.verifySigmaFloorCp`, because a score read at
 *    the human depth carries the shallow frame's own error on top of the misperception `sigmaFor`
 *    was calibrated for (HvS §5.4).
 *
 * What falls out is the report's error taxonomy rather than a softmax: candidate omission (the
 * best move was never among the k — Maia's own rate), truncation (the pick looks best at the
 * human depth and loses to what the deep referee sees) and evaluation error (σ on the shallow
 * scores). The rails, the mate guard and the timing model are untouched (C7).
 *
 * Pure apart from the seeded `rng`. `docs/qa/generate-verify-2026-09-13.md` records the design,
 * the tables and the fidelity budget.
 */

import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
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
	/** The score compared before noise: shallow cp when verified, the deep cp otherwise. */
	cp: number;
	/** `cp` plus the perception noise (equal to `cp` on the intuition path). */
	score: number;
	/** True when the shallow frame ranked the move; false when the deep score stood in. */
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
	return eloRamp(E, loElo, loProb, hiElo, hiProb);
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
export function generateAndVerify(input: GvInput): GvResult | null {
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
		const cp = c.shallowCp ?? c.deepCp;
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

/**
 * The empirical draw distribution `q(m)` over `samples` runs — the number the fidelity meters
 * and the harness (§8.2) read. When the path would return `null` the plain draw's distribution
 * (Maia's mass renormalised over the survivors) is returned instead, since that is what would
 * be played. Sums to 1.
 */
export function drawDistribution(
	input: Omit<GvInput, "rng">,
	samples: number,
	rng: Rng
): Map<string, number> {
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
