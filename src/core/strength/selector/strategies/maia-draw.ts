/** Through `MAIA.eloMax`: the human policy draws the move over the engine's scored lines. */

import { hangsOutright } from "@core/chess/safety";
import { MAIA } from "@core/constants/maia";
import type { ChosenMove } from "@typedefs/game";
import { blunderTerms } from "../../blunder-model";
import { SELECTION_CONSTANTS as C } from "../../constants";
import { searchedCp } from "../../conversion";
import { fmt } from "../../format";
import {
	drawMaiaFromSurvivors,
	type MaiaDraw,
	maiaSurvivors,
	policyProbabilities,
} from "../../maia-select";
import { simplificationFactors } from "../../simplification";
import { type Candidate, hangsPiece, matedLineFilter, populationStd } from "../candidate";
import { finishPick, type SelectionFrame, toCandidate } from "../frame";
import { hangRailProbability } from "../params";
import type { ResolvedPriors } from "../priors";
import {
	bandTieBreak,
	type MaiaVerified,
	maiaMeters,
	practicalDifficulty,
	scoredMassBefore,
	verifiedMaiaDraw,
} from "./maia-terms";

/**
 * Through `MAIA.eloMax`, the human policy draws the move over the engine's
 * scored lines — the main set and the extra `searchmoves` lines the pipeline added for Maia's
 * unscored favourites (`ctx.maiaExtra`, 2026-09-12) alike — with the rails on the engine's raw
 * scores, judged at `maiaE`. No perception jitter and no injected blunder channel here — the
 * population's error rate is in the distribution — so the `b` that would have applied is logged
 * and nothing else of step 6 runs. `null` (nothing scored with enough mass, or the rails emptied
 * the set) falls through to the ordinary policy.
 */
export function selectMaiaDraw(frame: SelectionFrame): ChosenMove | null {
	const { ctx, rationale, usable, conversion, baselineE } = frame;
	// The calibrated (tempered) policy, not `ctx.maia`: see `resolveMaiaRating`.
	const { maiaE, entropy, policy } = frame.maia;
	if (policy === undefined || maiaE === undefined) return null;
	const { rng, state } = ctx;
	const NP = C.neverPlay;
	const maiaProb = policyProbabilities(policy);
	const cands = frame.ranked.map((r) => toCandidate(frame, r));
	const extra = new Set(ctx.maiaExtra ?? []);
	const getsMated = matedLineFilter(cands, maiaE, rng, rationale);
	// H1: the hang rail ramps in with the rating, one draw per move, and below `cheapViewElo`
	// sees only one ply ahead. `lossCap` inside the draw stays the absolute backstop.
	const hangP = hangRailProbability(maiaE);
	const hangRailOn = hangP >= 1 || (hangP > 0 && rng.chance(hangP));
	const cheapView = maiaE < MAIA.hangRail.cheapViewElo;
	const hangs = (c: Candidate): boolean =>
		hangRailOn &&
		c.lossRaw >= NP.hangPieceLoss &&
		(cheapView ? hangsOutright(ctx.fen, c.uci) : hangsPiece(c.line, c.lossRaw, ctx.fen));
	const railState =
		hangP <= 0
			? `off (E<${MAIA.hangRail.offElo})`
			: hangP >= 1
				? "on"
				: `${hangRailOn ? "fired" : "skipped"} (p=${fmt(hangP, 2)})`;
	rationale.push(
		`maia hang rail: ${railState}${hangRailOn ? `, ${cheapView ? "one-ply" : "deep-PV"} view` : ""}`
	);
	const b = blunderTerms(baselineE, {
		myClockMs: ctx.myClockMs,
		cpStd: populationStd(cands.map((c) => c.cpRaw)),
		blunderScale: ctx.blunderScale,
		state,
		...(ctx.baseMs === undefined ? {} : { baseMs: ctx.baseMs }),
	}).b;
	// H11: kept so the pick's own terms reach the rationale.
	let bandPriors: ResolvedPriors | undefined;
	const tieBreak = bandTieBreak(frame, (priors) => {
		bandPriors = priors;
	});
	const byUci = new Map(cands.map((c) => [c.uci, c]));
	const bestSearchedCp = Math.max(...cands.map((c) => searchedCp(c.line)));
	const set = maiaSurvivors(
		cands.map((c) => ({
			uci: c.uci,
			mated: getsMated(c),
			hangs: hangs(c),
			lossRaw: c.lossRaw,
			cpLoss:
				searchedCp(c.line) === bestSearchedCp ? 0 : Math.max(0, bestSearchedCp - searchedCp(c.line)),
			extra: extra.has(c.uci),
		})),
		policy,
		maiaE,
		rationale,
		{ scoredMassBefore: scoredMassBefore(frame.lines, maiaProb) }
	);
	let draw: MaiaDraw | null = null;
	let verified: MaiaVerified | undefined;
	if (set !== null) {
		const simplification = simplificationFactors(ctx.fen, usable, ctx.phase);
		const exchangeRows = set.survivors.filter((s) => simplification.has(s.uci));
		if (exchangeRows.length > 0)
			rationale.push(
				`endgame simplification: safe piece exchanges weighted (${exchangeRows.map((s) => `${s.uci} ×${fmt(simplification.get(s.uci) ?? 1)}`).join(", ")})`
			);
		const practical = practicalDifficulty(frame, set, byUci);
		const gv = verifiedMaiaDraw(frame, policy, maiaE, set, byUci, simplification);
		if (gv !== null) ({ draw, verified } = gv);
		if (draw === null)
			draw = drawMaiaFromSurvivors(set, policy, maiaE, rng, rationale, {
				tieBreak,
				simplification,
				...(practical === undefined ? {} : { practical }),
			});
	}
	const pick = draw === null ? undefined : byUci.get(draw.uci);
	if (draw === null || pick === undefined) return null;
	if (draw.tieBand > 0 && bandPriors !== undefined) {
		pick.prior = bandPriors.values.get(pick.uci) ?? 1;
		pick.terms = bandPriors.terms.get(pick.uci) ?? [];
		if (
			conversion.active &&
			[...bandPriors.terms.values()].some((terms) =>
				terms.some((t) => t.rule === "conversion-progress")
			)
		)
			rationale.push("conversion: retaining the win with rating-sensitive progress");
	}
	rationale.push(`maia: no injected blunder channel (b=${fmt(b, 4)} would have applied)`);
	const chosen = finishPick(frame, pick, "maia");
	chosen.maiaProb = draw.p;
	chosen.maiaMeters = maiaMeters(maiaE, entropy, draw, verified);
	return chosen;
}
