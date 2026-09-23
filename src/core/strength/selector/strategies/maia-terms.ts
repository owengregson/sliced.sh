/**
 * The Maia strategy's supporting terms: the H13 practical-difficulty proxy, the H11 tie-band
 * prior, the generate-and-verify hand-off (H3) and the meters the pick reports.
 */

import { classifyMove } from "@core/chess/move-classify";
import { applyMoves } from "@core/chess/san";
import { GENERATE_VERIFY } from "@core/constants/generate-verify";
import { MAIA } from "@core/constants/maia";
import { upperVerificationProgress } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { MaiaMeters } from "@typedefs/game";
import { cpEffective, winProb } from "../../elo-map";
import { drawDistribution, type GvInput, generateAndVerify, gvKl } from "../../generate-verify";
import {
	type MaiaDraw,
	type MaiaPractical,
	type MaiaSurvivors,
	maiaDrawRecord,
} from "../../maia-select";
import type { Candidate } from "../candidate";
import { boostedPriors, type SelectionFrame } from "../frame";
import type { ResolvedPriors } from "../priors";

/** What generate-and-verify reports to the meters when it decided the pick. */
export interface MaiaVerified {
	candidates: number;
	verifyDepth: number;
}

/** Maia's mass on what the search scored, before the repetition/conversion guards (§7 D2). */
export function scoredMassBefore(
	lines: readonly EvalLine[],
	maiaProb: ReadonlyMap<string, number>
): number {
	let mass = 0;
	const seen = new Set<string>();
	for (const line of lines) {
		const uci = line.pvUci[0];
		if (uci === undefined || seen.has(uci)) continue;
		seen.add(uci);
		mass += maiaProb.get(uci) ?? 0;
	}
	return mass;
}

export function maiaMeters(
	selfElo: number,
	entropy: number,
	draw: Pick<MaiaDraw, "railedMass" | "unscoredMass" | "klFromMaia" | "maiaRank" | "survivors">,
	verified?: MaiaVerified
): MaiaMeters {
	return {
		selfElo,
		entropy,
		railedMass: draw.railedMass,
		unscoredMass: draw.unscoredMass,
		klFromMaia: draw.klFromMaia,
		rank: draw.maiaRank,
		survivors: draw.survivors,
		...(verified === undefined ? {} : verified),
	};
}

/**
 * H11: the technique prior decides only inside Maia's near-indifference band, and is resolved
 * for that band alone (§7 C1). `onResolve` keeps the band's priors so the pick's own terms reach
 * the rationale.
 */
export function bandTieBreak(
	frame: SelectionFrame,
	onResolve: (priors: ResolvedPriors) => void
): (band: readonly string[]) => ReadonlyMap<string, number> {
	return (band) => {
		const members = new Set(band);
		const bandPriors = boostedPriors(
			frame,
			frame.usable.filter((line) => members.has(line.pvUci[0] ?? ""))
		);
		onResolve(bandPriors);
		// Simplification also applies outside the tie band and in verification. Strip it
		// from this older prior so the plain draw cannot count the same preference twice.
		return new Map(
			[...bandPriors.values].map(([uci, value]) => {
				const factor =
					bandPriors.terms.get(uci)?.find((t) => t.rule === "endgame-simplification")?.factor ?? 1;
				return [uci, value / factor];
			})
		);
	};
}

/**
 * H13 (the free approximation): only when behind, and only inside the tie band, a candidate the
 * opponent must answer precisely — and quietly — is preferred. The proxy is documented on
 * `MAIA.practical`; the band's total mass does not move. `undefined` when the position does not
 * qualify.
 */
export function practicalDifficulty(
	frame: SelectionFrame,
	set: MaiaSurvivors,
	byUci: ReadonlyMap<string, Candidate>
): MaiaPractical | undefined {
	const P = MAIA.practical;
	if (!(P.enabled && frame.topCpRaw <= P.behindCp)) return undefined;
	const { fen } = frame.ctx;
	return (band: readonly string[]): ReadonlyMap<string, number> => {
		const out = new Map<string, number>();
		for (const uci of band) {
			const c = byUci.get(uci);
			if (c === undefined) continue;
			let bestOther: number | undefined;
			for (const s of set.survivors) {
				const o = s.uci === uci ? undefined : byUci.get(s.uci);
				if (o !== undefined && (bestOther === undefined || o.cpRaw > bestOther)) bestOther = o.cpRaw;
			}
			if (bestOther === undefined) {
				out.set(uci, 0);
				continue;
			}
			const sharpness = Math.abs(winProb(c.cpRaw) - winProb(bestOther));
			let trickiness = clamp(sharpness / P.minReplyLoss, 0, 1);
			const replySan = c.line.pvSan[1];
			const reply = c.line.pvUci[1];
			let forcing: boolean | undefined;
			if (replySan !== undefined) forcing = /[x+#]/.test(replySan);
			else if (reply !== undefined) {
				const after = applyMoves(fen, [uci]);
				const facts = after === null ? null : classifyMove(after, reply);
				if (facts !== null) forcing = facts.isCapture || facts.isCheck;
			}
			if (forcing === true) trickiness *= P.forcingReplyWeight;
			out.set(uci, trickiness);
		}
		return out;
	};
}

/**
 * H3: generate-and-verify takes the draw over when it has evidence — the human-depth comparison
 * frame, or (in the upper band) the bounded referee scores. `null` when it does not run or
 * declines (the plain draw decides); the rationale says which.
 */
export function verifiedMaiaDraw(
	frame: SelectionFrame,
	policy: PolicyResult,
	maiaE: number,
	set: MaiaSurvivors,
	byUci: ReadonlyMap<string, Candidate>,
	simplification: ReadonlyMap<string, number>
): { draw: MaiaDraw; verified: MaiaVerified } | null {
	const { ctx, rationale } = frame;
	// Upper verification can use the available referee evidence if the comparison frame
	// missed the deadline. Lower-range missing-frame behavior remains the plain draw.
	if (
		GENERATE_VERIFY.enabled &&
		(ctx.shallowLines !== undefined || upperVerificationProgress(maiaE) > 0)
	) {
		const shallow = new Map<string, number>();
		for (const l of ctx.shallowLines ?? []) {
			const u = l.pvUci[0];
			if (u !== undefined && !shallow.has(u)) shallow.set(u, cpEffective(l.score));
		}
		if (ctx.shallowLines === undefined)
			rationale.push("upper verification: comparison frame unavailable, using bounded referee scores");
		const gvInput: Omit<GvInput, "rng"> = {
			survivors: set.survivors.map((s) => {
				const sc = shallow.get(s.uci);
				return {
					uci: s.uci,
					p: (set.prob.get(s.uci) ?? 0) * (simplification.get(s.uci) ?? 1),
					deepCp: byUci.get(s.uci)?.cpRaw ?? 0,
					...(sc === undefined ? {} : { shallowCp: sc }),
				};
			}),
			E: maiaE,
			...(ctx.shallowDepth === undefined ? {} : { shallowDepth: ctx.shallowDepth }),
		};
		const gv = generateAndVerify({ ...gvInput, rng: ctx.rng });
		if (gv !== null) {
			rationale.push(...gv.rationale);
			rationale.push(
				"generate-verify: tie-band terms (technique prior, practical difficulty) skipped — the verification decides among the candidates"
			);
			// Ordinary verification has an exact law; only the upper band needs Monte Carlo.
			// Its separate seed never advances the game's rng.
			const q = drawDistribution(
				gvInput,
				GENERATE_VERIFY.meterSamples,
				createRng(`gv-meter:${ctx.fen}`)
			);
			const draw = maiaDrawRecord(
				set,
				policy,
				maiaE,
				gv.uci,
				{ klFromMaia: gvKl(q, set.prob), tieBand: 0, practicalBand: 0 },
				rationale
			);
			return { draw, verified: { candidates: gv.k, verifyDepth: gv.verifyDepth } };
		}
	} else if (GENERATE_VERIFY.enabled) {
		rationale.push("generate-verify: no human-depth frame for this search, plain draw");
	}
	return null;
}
