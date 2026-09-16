import { loadPosition } from "@core/chess/fen";
import { material, PIECE_VALUES } from "@core/chess/material";
import { type Phase, phase } from "@core/chess/phase";
import { playUci } from "@core/chess/san";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import { SELECTION_CONSTANTS as C } from "./constants";

/**
 * A bounded preference, never a quality override. Recognize an immediate piece exchange or
 * a quiet offer followed by capture/recapture on the offered square. Do not credit unrelated
 * exchanges deep in a PV, pawn liquidation, or a trade that spends our material advantage.
 * Engine scores remain unchanged; the caller applies these factors only to sampling weights.
 */
export function simplificationFactors(
	fen: string,
	lines: readonly EvalLine[],
	stage?: Phase
): Map<string, number> {
	const factors = new Map<string, number>();
	if ((stage ?? phase(fen)) !== "endgame") return factors;
	const S = C.endgame.simplification;
	// Do not trade away a searched forced mate, or trust bounds/missing scores as proof of a win.
	if (lines.some((line) => (line.score.mate ?? 0) > 0)) return factors;
	const best = Math.max(
		...lines.filter((line) => line.bound === undefined).map((line) => line.score.cp ?? -Infinity)
	);
	if (!Number.isFinite(best) || best <= S.minCp) return factors;
	const root = loadPosition(fen);
	const counts = material(fen);
	if (!root || !counts) return factors;
	const us = root.turn();
	const them = us === "w" ? "b" : "w";
	const lead = counts[us] - counts[them];
	if (lead < S.minMaterialLead) return factors;
	const opponentPieces = root
		.board()
		.flat()
		.reduce((sum, p) => sum + (p?.color === them && p.type !== "p" ? PIECE_VALUES[p.type] : 0), 0);
	if (opponentPieces <= 0) return factors;
	for (const line of lines) {
		const cp = line.score.cp;
		if (
			line.bound !== undefined ||
			line.score.mate !== undefined ||
			cp === undefined ||
			!Number.isFinite(cp) ||
			cp < S.minCp ||
			best - cp >= S.maxLossCp
		)
			continue;
		const board = loadPosition(fen);
		const uci = line.pvUci[0];
		if (!board || !uci) continue;
		const first = playUci(board, uci);
		if (!first || first.piece === "p" || first.piece === "k" || first.promotion) continue;
		const reply = line.pvUci[1] ? playUci(board, line.pvUci[1]) : null;
		if (!reply?.captured || reply.to !== first.to) continue;
		let removed = 0;
		if (first.captured && first.captured !== "p") {
			removed = PIECE_VALUES[first.captured];
		} else if (!first.captured) {
			const recapture = line.pvUci[2] ? playUci(board, line.pvUci[2]) : null;
			if (
				!recapture?.captured ||
				recapture.captured === "p" ||
				recapture.to !== first.to ||
				recapture.promotion
			)
				continue;
			removed = PIECE_VALUES[recapture.captured];
		}
		if (removed <= 0 || board.isDraw()) continue;
		const after = material(board.fen());
		if (!after || after[us] - after[them] < lead) continue;
		const advantage = clamp((best - S.minCp) / (S.fullCp - S.minCp), 0, 1);
		const quality = clamp(1 - (best - cp) / S.maxLossCp, 0, 1);
		const reduction = removed / opponentPieces;
		const factor = 1 + S.maxBonus * advantage * quality * reduction;
		if (factor > 1) factors.set(uci, factor);
	}
	return factors;
}
