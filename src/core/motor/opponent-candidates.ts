/** Plausible squares to inspect, grounded in legal moves on each side of an opponent reply. */
import { loadPosition } from "@core/chess/fen";
import type { Phase } from "@core/chess/phase";
import { playUci } from "@core/chess/san";
import type { EvalLine } from "@typedefs/engine";
import type { Color, Square } from "@typedefs/game";
import type { Chess } from "chess.js";
import { OPPONENT_EXPLORATION as O } from "./constants";
import type { MotorRepertoireContext } from "./repertoire";
import type { MoveCandidate, TimeControlClass } from "./types";

export type ExplorationSide = "own" | "opponent";

export interface OpponentExplorationPolicy {
	/** Tactical/queued contexts keep attention on our plausible replies. */
	ownOnly?: boolean;
	/** Shorter, quieter bouts when the clock calls for readiness. Also implies ownOnly. */
	lowTime?: boolean;
}

/** One move of a line as the pointer reads it: the piece, then where it goes. */
export interface ReadStep {
	from: Square;
	to: Square;
	side: ExplorationSide;
}

/** A PV read in move order — the opponent's reply, our answer, their next — never a rank scan. */
export interface LineReading {
	/** 0 for the top line; the planner weights lower ranks down, it does not scan them in order. */
	rank: number;
	steps: ReadStep[];
}

/**
 * What the attention plan is set from (owner, 2026-09-12). The session builds it in the live
 * `source()` it hands the executor, so a bout planned mid-turn sees the current think and clocks.
 */
export interface OpponentAttentionContext {
	repertoire?: MotorRepertoireContext;
	tcClass: TimeControlClass;
	/** How long the opponent has been thinking on this position. */
	opponentThinkMs: number;
	myClockMs: number;
	opponentClockMs: number;
	phase: Phase;
	/** A capture or a check among the top replies: a sharp middlegame holds longer traces. */
	sharp: boolean;
	/** A premove or a hold is armed: mostly still. */
	armed: boolean;
	/** The square we intend to move to next: never a rest spot. */
	intendedTo?: Square;
}

export interface OpponentExplorationCandidates {
	ownCandidates: MoveCandidate[];
	opponentCandidates: MoveCandidate[];
	policy?: OpponentExplorationPolicy;
	/** The top lines in reading order (empty without lines). */
	readings?: LineReading[];
	/** Our pieces the top replies attack — what a worried look checks. */
	threats?: Square[];
	kings?: { own: Square; opponent: Square };
	/** Every occupied square, for rest spots. */
	pieces?: Array<{ square: Square; side: ExplorationSide }>;
	/** The opponent's last move (their piece that just moved is looked at in a threat check). */
	lastMove?: { from: Square; to: Square };
	attention?: OpponentAttentionContext;
}

export function opponentExplorationCandidates(
	fen: string,
	myColor: Color,
	lines: readonly EvalLine[] = [],
	lastMove?: { from: Square; to: Square }
): OpponentExplorationCandidates {
	const result: OpponentExplorationCandidates = { ownCandidates: [], opponentCandidates: [] };
	const position = loadPosition(fen);
	if (!position || position.turn() === myColor) return result;
	const oppColor: Color = myColor === "w" ? "b" : "w";
	const own = new Map<string, MoveCandidate>();
	const opponent = new Map<string, MoveCandidate>();
	const put = (pool: Map<string, MoveCandidate>, move: MoveCandidate): void => {
		const key = `${move.from}${move.to}`;
		if ((pool.get(key)?.probability ?? 0) < move.probability) pool.set(key, move);
	};
	const readings: LineReading[] = [];
	for (const [index, line] of lines.entries()) {
		const reply = line.pvUci[0];
		if (!reply) continue;
		const branch = loadPosition(fen);
		if (!branch) continue;
		const first = playUci(branch, reply);
		if (!first) continue;
		put(opponent, { from: first.from, to: first.to, uci: reply, probability: 4 / (index + 1) });
		const steps: ReadStep[] = [{ from: first.from, to: first.to, side: "opponent" }];
		const answer = line.pvUci[1];
		const second = answer ? playUci(branch, answer) : null;
		if (answer && second && position.get(second.from)?.color === myColor) {
			put(own, { from: second.from, to: second.to, uci: answer, probability: 4 / (index + 1) });
			steps.push({ from: second.from, to: second.to, side: "own" });
			const next = line.pvUci[2];
			const third = next && steps.length < O.readingPlies ? playUci(branch, next) : null;
			if (third) steps.push({ from: third.from, to: third.to, side: "opponent" });
		}
		if (readings.length < O.readingLines) readings.push({ rank: index, steps });
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
	// Threats: our pieces the top replies' moved piece attacks once it has landed.
	const threats = new Set<Square>();
	const topReplies = [
		...lines.map((line) => line.pvUci[0]).filter((uci): uci is string => uci !== undefined),
		...shortlist.map((move) => move.uci),
	].slice(0, O.threatReplies);
	for (const uci of topReplies) {
		const branch = loadPosition(fen);
		const move = branch ? playUci(branch, uci) : null;
		if (!branch || !move) continue;
		for (const { square, side } of pieces(branch, myColor)) {
			if (side === "own" && branch.attackers(square, oppColor).includes(move.to)) threats.add(square);
		}
	}
	const ownKing = position.findPiece({ type: "k", color: myColor })[0];
	const oppKing = position.findPiece({ type: "k", color: oppColor })[0];
	return {
		ownCandidates: diversify([...own.values()], O.maxCandidates),
		opponentCandidates: shortlist,
		readings,
		threats: [...threats],
		...(ownKing && oppKing ? { kings: { own: ownKing, opponent: oppKing } } : {}),
		pieces: pieces(position, myColor),
		...(lastMove ? { lastMove } : {}),
	};
}

function pieces(position: Chess, myColor: Color): Array<{ square: Square; side: ExplorationSide }> {
	const out: Array<{ square: Square; side: ExplorationSide }> = [];
	for (const row of position.board()) {
		for (const cell of row) {
			if (cell) out.push({ square: cell.square, side: cell.color === myColor ? "own" : "opponent" });
		}
	}
	return out;
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

/** A capture or a check among the top replies (what makes the middlegame "sharp" for the plan). */
export function isSharp(fen: string, lines: readonly EvalLine[]): boolean {
	const position = loadPosition(fen);
	if (!position) return false;
	for (const line of lines.slice(0, O.threatReplies)) {
		const san = line.pvSan[0];
		if (san && /[x+#]/.test(san)) return true;
		const uci = line.pvUci[0];
		const branch = uci ? loadPosition(fen) : null;
		const move = branch && uci ? playUci(branch, uci) : null;
		if (move && /[x+#]/.test(move.san)) return true;
	}
	return false;
}
