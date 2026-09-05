/**
 * Time-pressure compression, hard caps and the long-think cap (Appendix D
 * §3a.3 / §3a.5) plus the premove logit (§3a.5). Head-independent: the
 * `TimingModel` applies them after any head, and the ChessMimic head reuses
 * the premove logit for its bucket-0 mapping. Untimed games (§8.4b item 1)
 * bypass compression and caps.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
import { uniform } from "./distributions";
import type { Features, Persona, TimingKnobs } from "./types";

const C = TIMING_CONSTANTS;

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

/**
 * A cap that binds is sampled in `cap · U(jitterMin, 1)` instead of clamping to the cap exactly,
 * so a binding cap never produces a constant per-move time (§8.4a); an unbound value passes through.
 */
export function jitteredCap(valueSec: number, capSec: number, rng: Rng): number {
	if (!(valueSec > capSec) || !Number.isFinite(capSec)) return valueSec;
	return capSec * uniform(rng, TIMING_CONSTANTS.caps.jitterMin, 1);
}

/** Multiplicative compression then the (jittered) hard caps (Appendix D §3a.3). */
export function applyPressureAndCaps(tSec: number, f: Features, rng: Rng): CappedTime {
	const comp = compressionFactor(f);
	const capSec = hardCapSec(f);
	return { tSec: jitteredCap(tSec * comp, capSec, rng), comp, capSec };
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

export interface BoundedTotal {
	totalSec: number;
	/** The plan is in the emergency regime (clock below §8.5's threshold, or `lo ≥ 1`). */
	emergency: boolean;
	/** Lower bound of the jitter as a fraction of the cap (0 when the cap is infinite). */
	lo: number;
	/** The cap bound the value. */
	bound: boolean;
}

/**
 * Bound a sampled total by the hard cap with every floor folded into the jitter's LOWER bound
 * — never a clamp after jittering (§8.4a): when the cap binds, `total = cap · U(lo, 1)` with
 * `lo = max(jitterMin, floorSec / cap)`. `lo ≥ 1` means the floors cannot fit under the cap:
 * the emergency regime, where `total = cap · U(jitterMin, 1)` and the phases compress below
 * their floors. `clockEmergency` (§8.5) forces the regime. An unbound value keeps its floor
 * outside the emergency regime (a floor on an unjittered value, which the sampled physical
 * phases practically never undercut).
 */
export function boundByCap(
	valueSec: number,
	capSec: number,
	floorSec: number,
	clockEmergency: boolean,
	rng: Rng
): BoundedTotal {
	if (!Number.isFinite(capSec))
		return {
			totalSec: clockEmergency ? valueSec : Math.max(valueSec, floorSec),
			emergency: clockEmergency,
			lo: 0,
			bound: false,
		};
	const lo = Math.max(TIMING_CONSTANTS.caps.jitterMin, floorSec / capSec);
	const emergency = clockEmergency || lo >= 1;
	if (valueSec > capSec)
		return {
			totalSec: capSec * uniform(rng, emergency ? TIMING_CONSTANTS.caps.jitterMin : lo, 1),
			emergency,
			lo,
			bound: true,
		};
	return {
		totalSec: emergency ? valueSec : Math.max(valueSec, floorSec),
		emergency,
		lo,
		bound: false,
	};
}
