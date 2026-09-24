/**
 * The engine's own strength-limited choice (`engine-elo`, and hybrid once its custom parameters
 * saturate), plus the upper referee cap that narrows the candidates before it and the base policy.
 */

import { loadPosition } from "@core/chess/fen";
import { applyMoves } from "@core/chess/san";
import { requestEloForTarget } from "@core/engine/options";
import { maiaMaxCpLoss, usesMaia } from "@core/policy/maia-size";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "../../constants";
import { searchedCp } from "../../conversion";
import { fmt } from "../../format";
import { avoidRepetition } from "../../repetition";
import { usesNativeSelection } from "../../selection-mode";
import { finishPick, type SelectionFrame, toCandidate } from "../frame";

/**
 * An unrestricted referee answer in the Maia range (the policy did not decide): keep only the
 * alternatives within the upper band's `maiaMaxCpLoss` of the leading line.
 */
export function applyUpperRefereeCap(frame: SelectionFrame): void {
	const { ctx } = frame;
	if (ctx.engineResultKind === "unrestricted" && usesMaia(ctx.targetElo)) {
		const cap = maiaMaxCpLoss(frame.maia.maiaE ?? frame.E);
		const leading = frame.ranked[0];
		if (Number.isFinite(cap) && leading !== undefined) {
			const best = searchedCp(leading.line);
			frame.ranked = frame.ranked.filter(
				(r) => searchedCp(r.line) === best || best - searchedCp(r.line) <= cap
			);
			frame.rationale.push(`upper referee fallback: retaining alternatives within ${fmt(cap, 0)} cp`);
		}
	}
}

/**
 * Retain native rating variation when Hybrid's custom parameters have saturated;
 * the ordinary gap and explicit-error thresholds can otherwise both reject its choice.
 */
export function selectNative(frame: SelectionFrame): ChosenMove | null {
	const { ctx, lines, ranked, rationale, E } = frame;
	if (
		ctx.engineResultKind === "unrestricted" ||
		!usesNativeSelection(ctx.selectionMode, E) ||
		frame.pressureReduction !== 0
	)
		return null;
	if (ctx.selectionMode === "hybrid")
		rationale.push(
			`hybrid: native selection at E≥${C.tau.pivotElo} (UCI_Elo ${requestEloForTarget(ctx.targetElo) ?? "unlimited"})`
		);
	const native = ctx.engineBestmove;
	const hasUnmated = ranked.some((r) => (r.line.score.mate ?? 0) >= 0);
	const idx = ranked.findIndex(
		(r) =>
			native !== undefined &&
			r.line.pvUci[0] === native &&
			!!applyMoves(ctx.fen, [native]) &&
			!(ctx.selectionMode === "hybrid" && hasUnmated && (r.line.score.mate ?? 0) < 0)
	);
	// Stockfish's strength limiter can choose outside the completed MultiPV set.
	// Preserve that legal choice, but never resurrect an evaluated move that a
	// guard removed. Its unknown score must not become a zero-loss observation —
	// nor, with a forced mate on the board (H9), a throw of the win nobody can judge.
	if (
		idx < 0 &&
		native &&
		!frame.throwWinFilter &&
		!lines.some((line) => line.pvUci[0] === native)
	) {
		const next = applyMoves(ctx.fen, [native]);
		const board = next ? loadPosition(next) : null;
		const probe: EvalLine = {
			multipv: 0,
			depth: 0,
			score: frame.originalRanks[0]?.score ?? {},
			pvUci: [native],
			pvSan: [],
		};
		// An optimistic score lets the existing repetition guard assess the move
		// without rejecting it merely for lacking a score; it is not used to select.
		const guard = avoidRepetition([...lines, probe], ctx.fen, ctx.history);
		const repetitionVeto = guard.avoided && !guard.lines.includes(probe);
		const drawVeto = frame.bestConversionCp >= C.repetition.aheadCp && board?.isDraw();
		if (board && !repetitionVeto && !drawVeto) {
			rationale.push("engine-elo: legal native bestmove outside the scored candidates");
			return finishPick(
				frame,
				{
					line: { ...probe, score: {} },
					uci: native,
					rank: 0,
					cpRaw: 0,
					cpEff: 0,
					loss: 0,
					lossRaw: 0,
					prior: 1,
					terms: [],
					mate: undefined,
				},
				"engine-elo"
			);
		}
	}
	const r = ranked[idx >= 0 ? idx : 0];
	if (r === undefined) throw new RangeError("selectMove: no lines");
	rationale.push(
		idx >= 0 ? "engine-elo: bestmove" : "engine-elo: bestmove unavailable or vetoed, top line"
	);
	return finishPick(frame, toCandidate(frame, r), "engine-elo");
}
