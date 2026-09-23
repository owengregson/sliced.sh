/**
 * tools/timing/clock-reference/reference.ts — the aggregate the export is reduced to
 * (`test/fixtures/timing/human-blitz-clock.json`): the human opponents of the window as the
 * control, our own side of the same games, and the most recent games on their own.
 */

import path from "node:path";
import type { ParsedGame } from "../../lib/pgn/export";
import { BUCKETS, type BucketSpec, type BucketStats, bucketedStats } from "./buckets";
import { clockMilestones, type Milestone, selectWindow, type WindowOptions } from "./window";

export interface ClockReference {
	generatedBy: string;
	source: { pgn: string; account: string; games: number };
	window: {
		timeControl: string;
		baseSec: number;
		incSec: number;
		minOurElo: number;
		minOppElo: number;
		minOurMoves: number;
		games: number;
		ourEloRange: [number, number];
		oppEloRange: [number, number];
		lostOnTime: number;
	};
	buckets: readonly BucketSpec[];
	/** The control: the human opponent of each game in the window. */
	human: Record<string, BucketStats>;
	/** The same games, our side — the "before" the acceptance tests are measured against. */
	sliced: Record<string, BucketStats>;
	/** Median clock left after the n-th move, both sides of the same games. */
	clockLeftAfterMove: Milestone[];
	/** The last `n` games of the window, where the regime moved faster than the 27-game mean. */
	recent: {
		games: number;
		human: Record<string, BucketStats>;
		sliced: Record<string, BucketStats>;
		clockLeftAfterMove: Milestone[];
	};
}

export function buildReference(
	games: ParsedGame[],
	o: WindowOptions & { pgn: string; recent: number }
): ClockReference {
	const rows = selectWindow(games, o);
	if (rows.length === 0) throw new Error("no games matched the window");
	const recent = rows.slice(-o.recent);
	const eloRange = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
	return {
		generatedBy: "tools/pgn-clock-reference.ts",
		source: { pgn: path.basename(o.pgn), account: o.account, games: games.length },
		window: {
			timeControl: `${o.baseSec}+${o.incSec}`,
			baseSec: o.baseSec,
			incSec: o.incSec,
			minOurElo: o.minOurElo,
			minOppElo: o.minOppElo,
			minOurMoves: o.minOurMoves,
			games: rows.length,
			ourEloRange: eloRange(rows.map((r) => r.ourElo)),
			oppEloRange: eloRange(rows.map((r) => r.oppElo)),
			lostOnTime: rows.filter((r) => r.lostOnTime).length,
		},
		buckets: BUCKETS,
		human: bucketedStats(rows.flatMap((r) => r.oppThinks)),
		sliced: bucketedStats(rows.flatMap((r) => r.ourThinks)),
		clockLeftAfterMove: clockMilestones(rows),
		recent: {
			games: recent.length,
			human: bucketedStats(recent.flatMap((r) => r.oppThinks)),
			sliced: bucketedStats(recent.flatMap((r) => r.ourThinks)),
			clockLeftAfterMove: clockMilestones(recent),
		},
	};
}
