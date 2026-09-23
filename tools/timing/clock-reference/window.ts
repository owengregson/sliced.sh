/**
 * tools/timing/clock-reference/window.ts — which games of the export are measured (the owner's
 * games at one time control and rating floor), and the clock each side had left after its n-th
 * move in them.
 */

import type { ParsedGame } from "../../lib/pgn/export";
import { type Think, thinksOf } from "../../lib/pgn/thinks";
import { percentile } from "../../lib/stats";
import { round } from "./buckets";

/** Our clock left after these move numbers (§2.1). */
const CLOCK_MILESTONES = [10, 15, 20, 30, 40, 50] as const;

export interface GameRow {
	index: number;
	date: string;
	ourElo: number;
	oppElo: number;
	ourSide: 0 | 1;
	ourThinks: Think[];
	oppThinks: Think[];
	lostOnTime: boolean;
	termination: string;
}

export interface WindowOptions {
	account: string;
	baseSec: number;
	incSec: number;
	minOurElo: number;
	minOppElo: number;
	minOurMoves: number;
}

export function selectWindow(games: ParsedGame[], o: WindowOptions): GameRow[] {
	const rows: GameRow[] = [];
	const account = o.account.toLowerCase();
	const tcWanted = o.incSec === 0 ? `${o.baseSec}` : `${o.baseSec}+${o.incSec}`;
	games.forEach((game, index) => {
		const h = game.headers;
		if ((h.TimeControl ?? "") !== tcWanted) return;
		const white = (h.White ?? "").toLowerCase();
		const black = (h.Black ?? "").toLowerCase();
		const ourSide: 0 | 1 | null = white === account ? 0 : black === account ? 1 : null;
		if (ourSide === null) return;
		const ourElo = Number(ourSide === 0 ? h.WhiteElo : h.BlackElo);
		const oppElo = Number(ourSide === 0 ? h.BlackElo : h.WhiteElo);
		if (!Number.isFinite(ourElo) || !Number.isFinite(oppElo)) return;
		if (ourElo < o.minOurElo || oppElo < o.minOppElo) return;
		const ourThinks = thinksOf(game, ourSide, o.baseSec, o.incSec);
		if (ourThinks.length < o.minOurMoves) return;
		const oppSide: 0 | 1 = ourSide === 0 ? 1 : 0;
		const termination = h.Termination ?? "";
		rows.push({
			index,
			date: h.Date ?? "",
			ourElo,
			oppElo,
			ourSide,
			ourThinks,
			oppThinks: thinksOf(game, oppSide, o.baseSec, o.incSec),
			lostOnTime: /on time/i.test(termination) && !termination.toLowerCase().startsWith(account),
			termination,
		});
	});
	return rows;
}

export interface Milestone {
	move: number;
	ourGames: number;
	oursS: number;
	humanGames: number;
	humanS: number;
}

/**
 * Median clock left after each side's n-th move. Each side is counted over the games **that side**
 * reached the move in, so a game that ended on our 29th move still contributes the human's 30th —
 * the two n's therefore differ by a game or two deep into a 3+0.
 */
export function clockMilestones(rows: GameRow[]): Milestone[] {
	const medianAfter = (thinks: Think[][], move: number): { n: number; s: number } => {
		const left = thinks
			.map((game) => game.find((t) => t.moveNo === move)?.clockAfterS)
			.filter((v): v is number => v !== undefined)
			.sort((a, b) => a - b);
		return { n: left.length, s: round(percentile(left, 50), 1) };
	};
	return CLOCK_MILESTONES.map((move) => {
		const ours = medianAfter(
			rows.map((r) => r.ourThinks),
			move
		);
		const human = medianAfter(
			rows.map((r) => r.oppThinks),
			move
		);
		return {
			move,
			ourGames: ours.n,
			oursS: ours.s,
			humanGames: human.n,
			humanS: human.s,
		};
	});
}
