/**
 * tools/telemetry-conformance/ac-model/rules.ts — the §13.2 / §9.6a / §8.4a rules: per-move
 * well-formedness and conduct, and the population bands over a batch.
 */

import { TELEMETRY_BANDS } from "../../../src/core/constants/telemetry";
import type { AcBlob } from "../../../src/types/telemetry";
import type { AcMoveMeta } from "./meta";
import { type AcSummary, summarizeAc } from "./summary";

export interface AcExpectations {
	/** Per-move context, aligned with `acs`; without it only the blob-level rules are checked. */
	moves?: readonly AcMoveMeta[];
}

export class AcConformanceError extends Error {
	constructor(readonly violations: string[]) {
		super(`ac conformance: ${violations.length} violation(s)\n  - ${violations.join("\n  - ")}`);
	}
}

/**
 * Whether the window this blob describes is one the **owner** owns rather than one we do. A
 * premove's window is opened over the *opponent's* turn (Fix F): the hand drags during their think,
 * so the period we put a record around is a period in which the owner is free to click whatever he
 * likes. A focus edge there is his behaviour, not ours — and §13.4 is a rule about the assistant
 * never moving focus, which it still never does.
 *
 * Two things have to agree, and neither is the move's `mode`: the **writer** must have said so
 * (`MoveTelemetryRecord.ownerOwnsWindow`, set only by the premove path and refused by
 * `MoveWindow.close` for a window opened on our own turn), and the blob must carry no own-turn edge.
 * Keying on `mode === "premove"` would have been a coincidence rather than a property — a searched
 * move can plan in that mode — so the fact is carried explicitly from the one place that knows it.
 */
function ownerOwnsTheWindow(ac: AcBlob, meta: AcMoveMeta | undefined): boolean {
	if (meta?.ownerOwnsWindow !== true) return false;
	return !(ac.DidBlurOnOwnTurn || ac.DidFocusOnOwnTurn);
}

/**
 * **Well-formedness**: what must be true of a single blob for it to describe a real window at all,
 * with no exemption and no sample size. This is the check Critical 1 needed and did not have — a
 * premove row came out with `MoveHoldTime 458` against `TotalFocusTime 0` because the row described
 * a window it was not in, and nothing in the repository ever looked at a premove row.
 *
 * The window-contains-the-hold rule is stated over the **whole** window (`TotalFocusTime +
 * TotalBlurTime`), because an owner blur inside a premove's window legitimately moves time from one
 * side of that split to the other; with no blur it reduces to the strict form.
 */
export function acWellFormedViolations(ac: AcBlob, at = "move"): string[] {
	const out: string[] = [];
	const finite = (name: string, value: number): boolean => {
		if (Number.isFinite(value) && value >= 0) return true;
		out.push(`${at}: ${name} ${value}`);
		return false;
	};
	const hold = finite("MoveHoldTime", ac.MoveHoldTime);
	const focus = finite("TotalFocusTime", ac.TotalFocusTime);
	const blur = finite("TotalBlurTime", ac.TotalBlurTime);
	finite("PointerOffset", ac.PointerOffset);
	if (hold && focus && blur && ac.TotalFocusTime + ac.TotalBlurTime < ac.MoveHoldTime)
		out.push(
			`${at}: the window (focus ${ac.TotalFocusTime.toFixed(0)} + blur ${ac.TotalBlurTime.toFixed(0)} ms) is shorter than MoveHoldTime ${ac.MoveHoldTime.toFixed(0)} ms`
		);
	// Internal consistency of the blur family: a row claiming no blur may not carry blur evidence.
	if (ac.BlurCount === 0) {
		if (ac.TotalBlurTime !== 0) out.push(`${at}: TotalBlurTime ${ac.TotalBlurTime} with BlurCount 0`);
		if (ac.DidBlurOnOwnTurn || ac.DidBlurOnOpponentTurn)
			out.push(`${at}: DidBlur… set with BlurCount 0`);
		if (ac.MoveToFirstBlurTime !== undefined)
			out.push(`${at}: MoveToFirstBlurTime set with BlurCount 0`);
		if (ac.DidToggle) out.push(`${at}: DidToggle with BlurCount 0`);
	}
	return out;
}

/**
 * **Conduct**: the §13.7 "what the extension must never do" rules that a single blob can answer —
 * untrusted input, a focus edge in a window we own, engine-like timing. Everything here is a
 * statement about *us*, which is why `ownerOwnsTheWindow` exempts the owner's own focus edges
 * during a premove rather than reporting them as our misconduct. They are still *reported*: the
 * game-level "zero blur events for the entire game" verdict in `report.py` counts every blur from
 * every row, because chess.com cannot tell who caused one either.
 */
export function acConductViolations(
	ac: AcBlob,
	meta: AcMoveMeta | undefined,
	at = "move"
): string[] {
	const B = TELEMETRY_BANDS;
	const out: string[] = [];
	const ownersWindow = ownerOwnsTheWindow(ac, meta);
	if (!ac.EventTrusted) out.push(`${at}: EventTrusted false`);
	if (ac.DidBlurOnOwnTurn || ac.DidFocusOnOwnTurn) out.push(`${at}: DidBlur…/DidFocus… on our turn`);
	if (!ownersWindow) {
		if (ac.BlurCount > B.blurCountMax) out.push(`${at}: BlurCount ${ac.BlurCount}`);
		if (ac.DidToggle) out.push(`${at}: DidToggle`);
		if (ac.DidBlurOnOpponentTurn || ac.DidFocusOnOpponentTurn)
			out.push(`${at}: DidBlur…/DidFocus… set`);
		if (ac.LastFocusToMoveTime !== undefined) out.push(`${at}: LastFocusToMoveTime set`);
		if (ac.MoveToFirstBlurTime !== undefined) out.push(`${at}: MoveToFirstBlurTime set`);
		if (ac.TotalBlurTime !== 0) out.push(`${at}: TotalBlurTime ${ac.TotalBlurTime}`);
		if (!(ac.TotalFocusTime >= ac.MoveHoldTime)) out.push(`${at}: TotalFocusTime < MoveHoldTime`);
	}
	const instantLike = meta !== undefined && (meta.mode === "premove" || meta.mode === "instant");
	if (!instantLike && ac.MoveHoldTime < B.holdTime.minMs)
		out.push(`${at}: MoveHoldTime ${ac.MoveHoldTime.toFixed(0)} ms < ${B.holdTime.minMs}`);
	return out;
}

/**
 * Every per-move rule — well-formedness and conduct — over a batch, with **no statistical band**.
 * This is what a premove row can be held to without pooling it into a population it does not belong
 * in: a premove press is a committed move attempt, not a §9.3a preview touch, so it has no business
 * in the preview-rate band (owner's ruling, Fix round 2). Throws `AcConformanceError`.
 */
export function assertWellFormedAc(
	acs: readonly AcBlob[],
	expectations: AcExpectations = {}
): void {
	const moves = expectations.moves;
	if (moves && moves.length !== acs.length)
		throw new AcConformanceError([`moves meta length ${moves.length} ≠ blobs ${acs.length}`]);
	const violations = acs.flatMap((ac, i) => [
		...acWellFormedViolations(ac, `move ${i}`),
		...acConductViolations(ac, moves?.[i], `move ${i}`),
	]);
	if (violations.length) throw new AcConformanceError(violations);
}

/**
 * Every §13.2 / §9.6a / §8.4a rule on a batch of blobs — one game's or a pooled
 * population's. The per-move rules — well-formedness and conduct, see
 * `assertWellFormedAc` — always apply; the hold-time floor skips
 * premove/instant moves when `moves` says so; the distribution bands (CV,
 * preview rate, complexity correlation, compression) apply once the sample is
 * large enough per `TELEMETRY_BANDS` — below that only the sample-size-free
 * invariants (hard preview cap, never 0 %, never 100 %) hold. Returns the
 * summary; throws `AcConformanceError` listing every violation.
 */
export function assertHumanShapedAc(
	acs: readonly AcBlob[],
	expectations: AcExpectations = {}
): AcSummary {
	const B = TELEMETRY_BANDS;
	const moves = expectations.moves;
	if (moves && moves.length !== acs.length)
		throw new AcConformanceError([`moves meta length ${moves.length} ≠ blobs ${acs.length}`]);
	const violations: string[] = [];
	acs.forEach((ac, i) => {
		const at = `move ${i}`;
		violations.push(...acWellFormedViolations(ac, at), ...acConductViolations(ac, moves?.[i], at));
	});
	const s = summarizeAc(acs, moves);
	if (s.holdNormal.n >= B.holdTime.cvAfterMoves && s.holdNormal.cv < B.holdTime.cvMin)
		violations.push(
			`hold-time CV ${s.holdNormal.cv.toFixed(2)} < ${B.holdTime.cvMin} over ${s.holdNormal.n} moves`
		);
	// The preview rate is a population statistic (§13.2): a single game only has to be
	// neither 0 % nor 100 % and to stay under the hard cap; the 4–12 % band is asserted
	// once the pooled sample reaches `minMovesForBand` non-trivial moves.
	if (s.multiSelect.eligible > 0 && s.multiSelect.rate !== null) {
		const { count, eligible, rate } = s.multiSelect;
		// The hard cap needs the same sample-size guard as the 0 %/100 % check below, and for the
		// same reason that check states: a handful of moves carries no information at p ≈ 7 %. It was
		// asserted from `eligible > 0`, so a game with four non-trivial moves and two previews read as
		// "50 % > 25 %". That is not a rate, it is two moves. Bullet made it reachable — non-triviality
		// needs a normal/long mode and `minThinkMs` of think, so a fast time control leaves only a few
		// eligible moves per game — but the gap was in the check, not in the hand.
		if (eligible >= B.multiSelect.minMovesForNonZero && rate > B.multiSelect.hardMax)
			violations.push(
				`multi-select rate ${(rate * 100).toFixed(1)} % (${count}/${eligible}) > ${B.multiSelect.hardMax * 100} %`
			);
		if (eligible >= B.multiSelect.minMovesForNonZero) {
			if (count === 0) violations.push(`multi-select rate 0 % over ${eligible} non-trivial moves`);
			else if (count === eligible)
				violations.push(`multi-select rate 100 % over ${eligible} non-trivial moves`);
		}
		if (eligible >= B.multiSelect.minMovesForBand) {
			const [lo, hi] = B.multiSelect.rate;
			if (rate < lo || rate > hi)
				violations.push(
					`multi-select rate ${(rate * 100).toFixed(1)} % (${count}/${eligible}) outside ${lo * 100}–${hi * 100} % over ${eligible} non-trivial moves`
				);
		}
	}
	if (
		s.holdVsComplexity !== null &&
		s.holdNormal.n >= B.holdTime.cvAfterMoves &&
		s.holdVsComplexity < B.holdTime.complexityCorrMin
	)
		violations.push(
			`hold-time vs n_reasonable correlation ${s.holdVsComplexity.toFixed(2)} < ${B.holdTime.complexityCorrMin}`
		);
	const c = s.compression;
	if (
		c.ratio !== null &&
		c.pressure.n >= B.compression.minMovesPerSide &&
		c.comfortable.n >= B.compression.minMovesPerSide &&
		c.ratio > B.compression.maxMeanRatio
	)
		violations.push(`time-pressure hold ratio ${c.ratio.toFixed(2)} > ${B.compression.maxMeanRatio}`);
	if (violations.length) throw new AcConformanceError(violations);
	return s;
}
