/** Plausible squares to inspect, grounded in legal moves on each side of an opponent reply. */
import { loadPosition } from "@core/chess/fen";
import { playUci } from "@core/chess/san";
import type { EvalLine } from "@typedefs/engine";
import type { Color } from "@typedefs/game";
import { OPPONENT_EXPLORATION as O } from "./constants";
import type { MoveCandidate } from "./types";

export interface OpponentExplorationPolicy {
	/** Tactical/queued contexts keep attention on our plausible replies. */
	ownOnly?: boolean;
	/** Shorter, quieter bouts when the clock calls for readiness. Also implies ownOnly. */
	lowTime?: boolean;
}

export interface OpponentExplorationCandidates {
	ownCandidates: MoveCandidate[];
	opponentCandidates: MoveCandidate[];
	policy?: OpponentExplorationPolicy;
}

export function opponentExplorationCandidates(
	fen: string,
	myColor: Color,
	lines: readonly EvalLine[] = []
): OpponentExplorationCandidates {
	const result: OpponentExplorationCandidates = { ownCandidates: [], opponentCandidates: [] };
	const position = loadPosition(fen);
	if (!position || position.turn() === myColor) return result;
	const own = new Map<string, MoveCandidate>();
	const opponent = new Map<string, MoveCandidate>();
	const put = (pool: Map<string, MoveCandidate>, move: MoveCandidate): void => {
		const key = `${move.from}${move.to}`;
		if ((pool.get(key)?.probability ?? 0) < move.probability) pool.set(key, move);
	};
	for (const [index, line] of lines.entries()) {
		const reply = line.pvUci[0];
		if (!reply) continue;
		const branch = loadPosition(fen);
		if (!branch) continue;
		const first = playUci(branch, reply);
		if (!first) continue;
		put(opponent, { from: first.from, to: first.to, uci: reply, probability: 4 / (index + 1) });
		const answer = line.pvUci[1];
		const second = answer ? playUci(branch, answer) : null;
		if (answer && second && position.get(second.from)?.color === myColor) {
			put(own, { from: second.from, to: second.to, uci: answer, probability: 4 / (index + 1) });
		}
	}
	const replies = position.moves({ verbose: true });
	for (const reply of replies) {
		const uci = `${reply.from}${reply.to}${reply.promotion ?? ""}`;
		put(opponent, {
			from: reply.from,
			to: reply.to,
			uci,
			probability: salience(reply.san, reply.to),
		});
	}
	const shortlist = diversify([...opponent.values()], O.maxCandidates);
	for (const reply of shortlist.slice(0, O.replyBranches)) {
		const branch = loadPosition(fen);
		if (!branch || !reply.uci || !playUci(branch, reply.uci)) continue;
		for (const answer of branch.moves({ verbose: true })) {
			// A future continuation can move a piece that no longer occupies this square now.
			if (position.get(answer.from)?.color !== myColor) continue;
			put(own, {
				from: answer.from,
				to: answer.to,
				uci: `${answer.from}${answer.to}${answer.promotion ?? ""}`,
				probability: salience(answer.san, answer.to),
			});
		}
	}
	return {
		ownCandidates: diversify([...own.values()], O.maxCandidates),
		opponentCandidates: shortlist,
	};
}

/** Prefer tactical and central possibilities; this only directs a free cursor, never chooses a move. */
function salience(san: string, to: string): number {
	return (
		1 +
		(san.includes("x") ? 0.8 : 0) +
		(/[+#]/.test(san) ? 0.6 : 0) +
		(/^[c-f][3-6]$/.test(to) ? 0.35 : 0)
	);
}

function diversify(moves: MoveCandidate[], limit: number): MoveCandidate[] {
	moves.sort((a, b) => b.probability - a.probability);
	const seen = new Set<string>();
	const first: MoveCandidate[] = [];
	const rest: MoveCandidate[] = [];
	for (const move of moves) {
		(seen.has(move.from) ? rest : first).push(move);
		seen.add(move.from);
	}
	return [...first, ...rest].slice(0, limit);
}
