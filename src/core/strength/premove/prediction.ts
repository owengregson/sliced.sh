/** Predicting the opponent's reply from a short MultiPV search. */

import { PREMOVE } from "@core/constants/books";
import type { EvalLine } from "@typedefs/engine";
import { cpEffective, winProb } from "../elo-map";

/** Softmax(τ = 0.06) over the opponent lines' win fractions; 0 when `reply` is not among them. */
export function replyProbability(reply: string, lines: readonly EvalLine[]): number {
	if (lines.length === 0) return 0;
	const wins = lines.map((line) => winProb(cpEffective(line.score)));
	const max = Math.max(...wins);
	let total = 0;
	let own = 0;
	for (let i = 0; i < lines.length; i++) {
		const w = Math.exp(((wins[i] ?? 0) - max) / PREMOVE.replyTau);
		total += w;
		if (lines[i]?.pvUci[0] === reply) own += w;
	}
	return total > 0 ? own / total : 0;
}

/** Only fresh, distinct, comparable root scores are evidence about the next opponent move. */
export function predictionLines(
	lines: readonly EvalLine[],
	legalReplies: readonly string[]
): EvalLine[] {
	const roots = new Set<string>();
	return [...lines]
		.sort((a, b) => a.multipv - b.multipv)
		.filter((line) => {
			const reply = line.pvUci[0];
			if (
				!reply ||
				!legalReplies.includes(reply) ||
				roots.has(reply) ||
				line.bound !== undefined ||
				!Number.isFinite(line.depth) ||
				line.depth < PREMOVE.replyMinDepth ||
				!(Number.isFinite(line.score.cp) || Number.isFinite(line.score.mate))
			)
				return false;
			roots.add(reply);
			return true;
		});
}

export function plausibleScore(candidate: EvalLine, best: EvalLine): boolean {
	if (best.score.mate !== undefined) {
		if (candidate.score.mate === undefined) return best.score.mate < 0;
		if (best.score.mate > 0)
			return candidate.score.mate > 0 && candidate.score.mate <= best.score.mate;
		return candidate.score.mate < 0 && candidate.score.mate <= best.score.mate;
	}
	if (candidate.score.mate !== undefined) return candidate.score.mate > 0;
	return (best.score.cp ?? 0) - (candidate.score.cp ?? 0) <= PREMOVE.replyMaxCpLoss;
}
