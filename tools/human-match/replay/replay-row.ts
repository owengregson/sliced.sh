/**
 * tools/human-match/replay/replay-row.ts — one corpus position through the **full selection
 * wrapper**: repeated seeded `selectMove` calls estimate the final sampling distribution `q(m)`,
 * and the loss facts of the human move and the bot's expectation under `q` are read off the
 * referee lines.
 */

import { parseFen, plyOf } from "@core/chess/fen";
import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves, parseUci } from "@core/chess/san";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { createSelectionState, hangsPiece, selectMove } from "@core/strength/move-selector";
import { heuristicPrior } from "@core/strength/prior";
import { rankedLines } from "@core/strength/quality";
import type { SelectionContext } from "@core/strength/types";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { bucketOf, type CorpusRow, type FrameRecord } from "./corpus";

/** Loss facts of one move (for the human) or `q`-expectations of them (for the bot). */
export interface MoveFacts {
	lossCp: number;
	inaccuracy: number;
	mistake: number;
	blunder: number;
	hang: number;
	mate: number;
	samePiece: number;
}

export const MOVE_FACT_KEYS: Array<keyof MoveFacts> = [
	"lossCp",
	"inaccuracy",
	"mistake",
	"blunder",
	"hang",
	"mate",
	"samePiece",
];

export interface RowResult {
	id: string;
	gameId: string | undefined;
	ply: number;
	bucket: number;
	legal: number;
	/** `q(m)` over the drawn moves. */
	q: Map<string, number>;
	sources: Map<ChosenMove["source"], number>;
	meters: { kl: number; railed: number; unscored: number; n: number };
	humanScored: boolean;
	/** Human move: raw Maia p, and the row's loss facts. */
	pHuman: number;
	human: MoveFacts | null;
	humanMove: string;
	/** The bot's expectations under `q`. */
	bot: MoveFacts;
	topQ: string | undefined;
	topP: string | undefined;
	hasMate: boolean;
	hasPrev: boolean;
}

const LICHESS_DROPS = { inaccuracy: 0.1, mistake: 0.2, blunder: 0.3 } as const;

export function replayRow(
	row: CorpusRow,
	id: string,
	frame: FrameRecord,
	policy: PolicyResult | null,
	draws: number,
	seed: string
): RowResult {
	const ranked = rankedLines(frame.lines);
	const top = ranked[0];
	if (!top) throw new Error(`${id}: the frame has no scored line`);
	const topCp = cpEffective(top.score);
	const winTop = winProb(topCp);
	const byUci = new Map<string, EvalLine>();
	for (const line of ranked) byUci.set(line.pvUci[0] ?? "", line);
	const prevTo = row.prevOwnMove === undefined ? undefined : parseUci(row.prevOwnMove)?.to;
	const facts = (line: EvalLine, uci: string): MoveFacts => {
		const cp = cpEffective(line.score);
		const drop = winTop - winProb(cp);
		return {
			lossCp: Math.max(0, topCp - cp),
			inaccuracy: drop >= LICHESS_DROPS.inaccuracy ? 1 : 0,
			mistake: drop >= LICHESS_DROPS.mistake ? 1 : 0,
			blunder: drop >= LICHESS_DROPS.blunder ? 1 : 0,
			hang: hangsPiece(line, drop, row.fen) ? 1 : 0,
			mate: (line.score.mate ?? 0) > 0 ? 1 : 0,
			samePiece: prevTo !== undefined && parseUci(uci)?.from === prevTo ? 1 : 0,
		};
	};

	const parts = parseFen(row.fen);
	const ply = row.ply ?? (parts ? plyOf(parts) : 0);
	const legal = legalMoves(row.fen);
	const base: Omit<SelectionContext, "rng" | "state"> = {
		fen: row.fen,
		targetElo: row.selfElo,
		form: 0,
		ply,
		phase: phaseOf(row.fen, ply) ?? "middlegame",
		myClockMs: row.clockMs,
		oppClockMs: row.oppClockMs ?? row.clockMs,
		selectionMode: "hybrid",
		blunderScale: 1,
		...(row.baseMs === undefined ? {} : { baseMs: row.baseMs }),
		...(row.incrementMs === undefined ? {} : { incrementMs: row.incrementMs }),
		...(row.lastMove === undefined ? {} : { lastMove: row.lastMove }),
		...(frame.bestmove === null ? {} : { engineBestmove: frame.bestmove }),
		...(policy === null ? {} : { maia: policy, maiaExtra: frame.extra }),
	};
	const prior = heuristicPrior(row.fen, frame.lines, { ...base, state: createSelectionState() });
	const rng = createRng(`${seed}:${id}`);
	const counts = new Map<string, number>();
	const sources = new Map<ChosenMove["source"], number>();
	const meters = { kl: 0, railed: 0, unscored: 0, n: 0 };
	for (let i = 0; i < draws; i++) {
		const m = selectMove(frame.lines, { ...base, rng, state: createSelectionState() }, prior);
		counts.set(m.uci, (counts.get(m.uci) ?? 0) + 1);
		sources.set(m.source, (sources.get(m.source) ?? 0) + 1);
		if (m.maiaMeters) {
			meters.n++;
			meters.kl += m.maiaMeters.klFromMaia;
			meters.railed += m.maiaMeters.railedMass;
			meters.unscored += m.maiaMeters.unscoredMass;
		}
	}
	const q = new Map<string, number>();
	for (const [uci, n] of counts) q.set(uci, n / draws);
	const bot: MoveFacts = {
		lossCp: 0,
		inaccuracy: 0,
		mistake: 0,
		blunder: 0,
		hang: 0,
		mate: 0,
		samePiece: 0,
	};
	for (const [uci, weight] of q) {
		const line = byUci.get(uci);
		if (!line) continue;
		const f = facts(line, uci);
		for (const key of Object.keys(bot) as Array<keyof MoveFacts>) bot[key] += weight * f[key];
	}
	const humanLine = byUci.get(row.humanMove) ?? frame.humanLine;
	const pHuman = policy?.moves.find(([uci]) => uci === row.humanMove)?.[1] ?? 0;
	let topQ: string | undefined;
	let topQn = -1;
	for (const [uci, n] of counts)
		if (n > topQn) {
			topQ = uci;
			topQn = n;
		}
	return {
		id,
		gameId: row.gameId,
		ply,
		bucket: row.bucket ?? bucketOf(row.selfElo),
		legal: legal.length,
		q,
		sources,
		meters,
		humanScored: byUci.has(row.humanMove),
		pHuman,
		human: humanLine ? facts(humanLine, row.humanMove) : null,
		humanMove: row.humanMove,
		bot,
		topQ,
		topP: policy?.moves[0]?.[0],
		hasMate: ranked.some((l) => (l.score.mate ?? 0) > 0),
		hasPrev: prevTo !== undefined,
	};
}
