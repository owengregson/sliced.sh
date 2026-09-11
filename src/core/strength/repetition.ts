import {
	matchingHistory,
	type PositionHistory,
	positionKey,
	replayHistory,
} from "@core/chess/history";
import { playUci } from "@core/chess/san";
import type { EvalLine } from "@typedefs/engine";
import { SELECTION_CONSTANTS as C } from "./constants";
import { cpEffective } from "./elo-map";

/** 2 means a draw can be claimed now/next reply; 1 starts a cycle; -1 is illegal. */
export function repetitionRisk(history: PositionHistory, move: string): number {
	return repetitionRisks(history, [move])[0] ?? 0;
}

/** Replay once for the whole MultiPV pool, and examine opponent replies only near a repeat. */
function repetitionRisks(history: PositionHistory, moves: readonly string[]): number[] {
	const chess = replayHistory(history);
	if (!chess) return moves.map(() => 0);
	const keys = chess.history({ verbose: true }).map((m) => positionKey(m.before));
	keys.push(positionKey(chess.fen()));
	const visited = new Set(keys);
	const repeatedBefore = visited.size < keys.length;
	return moves.map((move) => {
		if (!playUci(chess, move)) return -1;
		let risk = visited.has(positionKey(chess.fen())) ? 1 : 0;
		if (chess.isCheckmate()) risk = 0;
		else if (chess.isThreefoldRepetition()) risk = 2;
		else if (repeatedBefore) {
			// A drawing reply need not be in the engine PV.
			for (const reply of chess.moves()) {
				chess.move(reply);
				const draw = chess.isThreefoldRepetition();
				chess.undo();
				if (draw) {
					risk = 2;
					break;
				}
			}
		}
		chess.undo();
		return risk;
	});
}

/**
 * Keep an evaluated advantage instead of sampling a repetition. Losing/equal positions keep
 * their drawing resource; a lone repetition is retained if no sound alternative was searched.
 */
export function avoidRepetition(
	lines: readonly EvalLine[],
	fen: string,
	history: PositionHistory | undefined
): { lines: EvalLine[]; avoided: boolean } {
	const valid = matchingHistory(history, fen);
	if (!valid || valid.moves.length === 0) return { lines: [...lines], avoided: false };
	const best = Math.max(...lines.map((line) => cpEffective(line.score)));
	if (best < C.repetition.aheadCp) return { lines: [...lines], avoided: false };
	const risks = repetitionRisks(
		valid,
		lines.map((line) => line.pvUci[0] ?? "")
	);
	if (!risks.some((risk) => risk > 0)) return { lines: [...lines], avoided: false };
	const safe = lines.filter((line, i) => {
		const cp = cpEffective(line.score);
		return (
			risks[i] === 0 && cp >= C.repetition.keepAdvantageCp && cp >= best - C.repetition.maxLossCp
		);
	});
	if (safe.length === 0) return { lines: [...lines], avoided: false };
	return { lines: safe, avoided: true };
}
