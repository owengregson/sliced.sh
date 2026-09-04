/**
 * v1 parametric distribution head (Appendix D §3a.3–§3a.5, Appendix D
 * "Appendix A" reference implementation): premove / instant spike, log-normal
 * body with the AR(1) residual, Pareto long-think tail. Time-pressure
 * compression and the hard caps (§3a.3) are exported separately because the
 * `TimingModel` applies them after any head.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
import { pareto, sigmoid } from "./distributions";
import type {
	DistributionHead,
	Features,
	GameTimingState,
	HeadSample,
	Persona,
	TimingKnobs,
	TimingMode,
} from "./types";

const C = TIMING_CONSTANTS;

/** `p(e) = p0 + p1·elo_z`. */
function eloDep(p: readonly [number, number], e: number): number {
	return p[0] + p[1] * e;
}

export interface BodyTerms {
	sum: number;
	terms: Array<[string, number]>;
}

/** `Σ β_i f_i` of Appendix D §3a.3 with per-term contributions (mirroring uses the persona's ρ). */
export function bodyTerms(f: Features, p: Persona, e: number): BodyTerms {
	const B = C.beta;
	const lost = f.eval_cp > B.lostLoCp && f.eval_cp < B.lostHiCp ? 1 : 0;
	const dead = f.eval_cp <= B.deadCp ? 1 : 0;
	const won = f.eval_cp >= B.wonCp ? 1 : 0;
	const terms: Array<[string, number]> = [
		["book", eloDep(B.book, e) * f.in_book],
		["phase", B.phaseMid * f.phase_mid + B.phaseEnd * f.phase_end],
		["invertedU", B.invertedU * (-((f.ply - B.uCentrePly) ** 2) / B.uWidth)],
		["cplx", eloDep(B.cplx, e) * (f.ln_n_reasonable - Math.log(B.cplxRefLines))],
		["dec", eloDep(B.dec, e) * -f.decisiveness],
		["gap", B.gap * f.chosen_gap],
		["forced", B.forced * f.is_forced],
		["recap", B.recap * f.is_recapture],
		["only", B.only * f.is_only_legal],
		["ponder", B.ponder * f.ponder_hit],
		["swing", B.swing * f.swing_bad],
		["evalAbs", B.evalAbs * f.eval_abs],
		["lost", B.lost * lost],
		["dead", B.dead * dead],
		["won", B.won * won],
		["check", B.check * f.is_check],
		["promo", B.promo * f.is_promotion],
		["mirror", p.rho_mirror * f.opp_pace],
		["legal", B.legal * (f.n_legal - Math.log(B.legalRefMoves))],
		["ratio", B.ratio * f.clock_ratio],
	];
	let sum = 0;
	for (const [, v] of terms) sum += v;
	return { sum, terms };
}

/** `σ = σ0 + σ1·elo_z + 0.10·phase_mid − 0.08·in_book`, scaled by the variance knob. */
export function sigmaOf(f: Features, e: number, knobs: Pick<TimingKnobs, "sigmaScale">): number {
	const s =
		C.sigma.base + C.sigma.elo * e + C.sigma.phaseMid * f.phase_mid + C.sigma.book * f.in_book;
	return Math.max(C.sigma.min, s * knobs.sigmaScale);
}

export function phiOf(e: number): number {
	return C.phi.base + C.phi.elo * e;
}

/** Appendix D §3a.3 compression factor (1 for untimed games). */
export function compressionFactor(f: Features): number {
	if (f.tc === "untimed") return 1;
	const K = C.compression;
	const cl = f.clock_s;
	let comp = 1;
	if (cl < K.clockS || f.pressure < K.pressure)
		comp *= clamp(K.floor + (1 - K.floor) * Math.min(1, cl / K.clockS), K.floor, 1);
	if (cl < K.panicClockS) comp *= clamp(cl / K.panicClockS, K.panicFloor, 1);
	if (f.inc_s >= K.incFloorIncS && cl > K.incFloorClockS) comp = Math.max(comp, K.incFloor);
	return comp;
}

/** Hard cap in seconds (`∞` for untimed games). */
export function hardCapSec(f: Features): number {
	if (f.tc === "untimed") return Number.POSITIVE_INFINITY;
	const K = C.caps;
	const cl = f.clock_s;
	let cap = K.fraction * cl;
	if (cl < K.lowClockS && f.inc_s < K.lowIncS) cap = Math.min(cap, K.lowFraction * cl);
	if (cl < K.tinyClockS) cap = Math.min(cap, K.tinyCapS);
	return cap;
}

export interface CappedTime {
	tSec: number;
	comp: number;
	capSec: number;
}

/** Multiplicative compression then the hard caps (Appendix D §3a.3). */
export function applyPressureAndCaps(tSec: number, f: Features): CappedTime {
	const comp = compressionFactor(f);
	const capSec = hardCapSec(f);
	return { tSec: Math.min(tSec * comp, capSec), comp, capSec };
}

/** Long-think cap: `min(0.25·C, per-class cap)`. */
export function longThinkCapSec(f: Features): number {
	const L = C.longThink;
	const byClass = L.capS[f.tc];
	return f.tc === "untimed" ? byClass : Math.min(L.capFraction * f.clock_s, byClass);
}

/** Appendix D §3a.5 premove logit (shared with the ChessMimic head's bucket-0 mapping). */
export function premoveLogit(
	f: Features,
	p: Persona,
	knobs: Pick<TimingKnobs, "piOffset">
): number {
	const P = C.premove;
	const cl = f.clock_s;
	const untimed = f.tc === "untimed";
	return (
		P.aTc[f.tc] +
		P.recap * f.is_recapture +
		P.book * f.in_book +
		P.only * f.is_only_legal +
		P.ponder * f.ponder_hit +
		(!untimed && cl < P.clock10S ? P.clockUnder10 : 0) +
		(!untimed && cl < P.clock20S ? P.clockUnder20 : 0) +
		P.lnNReasonable * f.ln_n_reasonable +
		P.swingBad * f.swing_bad +
		p.pi_p +
		knobs.piOffset +
		(f.tc === "bullet" ? P.eloBullet * f.elo_z : 0)
	);
}

export class V1ParametricHead implements DistributionHead {
	readonly id = "v1-parametric" as const;

	/** Body median: `alloc · exp(Σβf − mirror + s_game)` (no residual, no mirroring, no tilt). */
	median(f: Features, p: Persona, allocSec: number): number {
		const body = bodyTerms(f, p, f.elo_z);
		const mirror = body.terms.find(([n]) => n === "mirror")?.[1] ?? 0;
		return allocSec * Math.exp(body.sum - mirror + p.s_game);
	}

	sample(f: Features, p: Persona, st: GameTimingState, rng: Rng, allocSec: number): HeadSample {
		const why: string[] = [];
		const cl = f.clock_s;
		const e = f.elo_z;
		const knobs = st.knobs;
		const untimed = f.tc === "untimed";
		// 1. premove
		if (f.premove_eligible) {
			const pPre = sigmoid(premoveLogit(f, p, knobs));
			if (rng.next() < pPre)
				return {
					tSec: rng.next() * C.premove.maxS,
					mode: "premove",
					why: [`premove p=${pPre.toFixed(2)}`],
				};
		}
		// 2. instant
		const I = C.instant;
		const li =
			I.bTc[f.tc] +
			I.recap * f.is_recapture +
			I.forced * f.is_forced +
			I.ponder * f.ponder_hit +
			I.book * f.in_book +
			(!untimed && cl < C.premove.clock20S ? I.clockUnder20 : 0) +
			I.lnNReasonable * f.ln_n_reasonable +
			I.iota * p.iota +
			I.decisivenessInv / Math.max(f.decisiveness, I.decisivenessInvFloor) +
			(st.tilt > 0 ? C.tilt.instantIota * p.iota : 0);
		const pInst = sigmoid(li);
		if (rng.next() < pInst)
			return {
				tSec: I.minS + I.rangeS * rng.next(),
				mode: "instant",
				why: [`instant p=${pInst.toFixed(2)}`],
			};
		// 3. body
		const body = bodyTerms(f, p, e);
		const sigma = sigmaOf(f, e, knobs);
		const phi = phiOf(e);
		if (!st.freezeEps) st.eps = phi * st.eps + Math.sqrt(1 - phi * phi) * sigma * rng.normal();
		const tiltTerm = st.tilt > 0 ? C.tilt.bodyIota * p.iota : 0;
		const logT = Math.log(allocSec) + body.sum + p.s_game + st.eps - tiltTerm;
		let t = Math.exp(logT);
		let mode: TimingMode = "normal";
		why.push(`body alloc=${allocSec.toFixed(2)} Σβf=${body.sum.toFixed(2)} ε=${st.eps.toFixed(2)}`);
		if (st.tilt > 0) why.push(`tilt ${st.tilt}`);
		// 4. long think
		const L = C.longThink;
		if (untimed || (cl >= L.minClockS && f.pressure >= L.minPressure)) {
			const K = L.crit;
			const crit = clamp(
				K.lnN * f.ln_n_reasonable +
					K.swing * f.swing_bad +
					K.balanced * (Math.abs(f.eval_cp) < K.balancedCp ? 1 : 0) +
					K.phaseMid * f.phase_mid +
					K.dec * f.decisiveness,
				0,
				K.max
			);
			const pLong = clamp(
				eloDep(L.lambda0, e) *
					knobs.lambdaScale *
					Math.exp(L.critExp * crit) *
					(L.tauBase + L.tauWeight * p.tau),
				0,
				L.pMax
			);
			if (rng.next() < pLong) {
				t *= L.paretoShift + pareto(rng, L.paretoAlpha, L.paretoXm);
				t = Math.min(t, longThinkCapSec(f));
				mode = "long";
				why.push(`long think p=${pLong.toFixed(3)} crit=${crit.toFixed(2)}`);
			}
		}
		return { tSec: t, mode, why, terms: body.terms };
	}
}
