/**
 * tools/move-review/score/classify.ts — every move of every game through the extension's own
 * `classifyMoveQuality`, tallied against chess.com's marks.
 */

import {
	classifyMoveQuality,
	type MoveQualityTuning,
	passedBrilliantGates,
} from "@core/engine/move-quality";
import { numericTag } from "../../lib/pgn/export";
import { replayGame } from "../dataset";
import { type BenchmarkGame, brilliantPlies } from "../evidence";
import { type FrameSet, reviewFrameOf } from "./frames";

export interface Called {
	game: number;
	ply: number;
	san: string;
	rating: number | undefined;
	reason?: string;
	loss?: number;
	played?: number;
	alternative?: number;
	/** `shape:concession` of every offer the gates saw. */
	offers?: string[];
}

/** chess.com's other marks (`GreatFind`, `Blunder`, …) next to the classifier's rating. */
export interface Mark {
	game: number;
	ply: number;
	san: string;
	chesscom: string;
	ours: string;
}

export interface Tally {
	distribution: Record<string, number>;
	labelledQualities: Record<string, number>;
	labelledReasons: Record<string, number>;
	missed: Called[];
	overCalls: Called[];
	recalledCalls: Called[];
	marks: Mark[];
	negativeCalls: Called[];
	labelledTotal: number;
	recalled: number;
	labelledClassified: number;
	otherClassified: number;
	unclassified: number;
	negativeClassified: number;
	falsePositives: number;
	missingFrames: number;
}

export interface ClassifyOptions {
	tuning: MoveQualityTuning;
	inBook: (fen: string, uci: string) => boolean;
	/**
	 * `--rating none|<elo>`: grade every mover at that rating instead of the PGN's (what the live
	 * reporter does when the page reports no rating, or the opponent's for both sides). `null` =
	 * the PGN headers; `undefined` = no rating.
	 */
	forcedRating: number | undefined | null;
}

export function classifyGames(
	games: readonly BenchmarkGame[],
	set: FrameSet,
	options: ClassifyOptions
): Tally {
	const { tuning, inBook, forcedRating: forced } = options;
	const t: Tally = {
		distribution: {},
		labelledQualities: {},
		labelledReasons: {},
		missed: [],
		overCalls: [],
		recalledCalls: [],
		marks: [],
		negativeCalls: [],
		labelledTotal: 0,
		recalled: 0,
		labelledClassified: 0,
		otherClassified: 0,
		unclassified: 0,
		negativeClassified: 0,
		falsePositives: 0,
		missingFrames: 0,
	};
	for (const [game, entry] of games.entries()) {
		const { history } = replayGame(entry);
		const ratings =
			forced === null
				? { w: numericTag(entry.pgn, "WhiteElo"), b: numericTag(entry.pgn, "BlackElo") }
				: { w: forced, b: forced };
		const brilliants = new Set(brilliantPlies(entry));
		/** 0-based indices whose move passed every brilliant gate (the live reporter's window). */
		const sacrifices = new Set<number>();
		t.labelledTotal += brilliants.size;
		for (const [index, move] of history.entries()) {
			const before = reviewFrameOf(set, game, index);
			if (!before) {
				t.missingFrames += 1;
				continue;
			}
			if (set.frames.get(`${game}:${index}`)?.fen !== move.before)
				throw new Error(`Position mismatch ${game}:${index}`);
			const labelled = brilliants.has(index + 1);
			const uci = move.from + move.to + (move.promotion ?? "");
			const verdict = classifyMoveQuality(
				{
					fen: move.before,
					uci,
					before,
					after: reviewFrameOf(set, game, index + 1),
					previous: reviewFrameOf(set, game, index - 1),
					moverRating: ratings[move.color],
					inBook: inBook(move.before, uci),
					recentSacrifice: Array.from(
						{ length: Math.floor(tuning.brilliant.sequencePlies / 2) },
						(_, k) => index - 2 * (k + 1)
					).some((earlier) => sacrifices.has(earlier)),
				},
				tuning
			);
			if (!verdict) {
				t.unclassified += 1;
				continue;
			}
			if (passedBrilliantGates(verdict)) sacrifices.add(index);
			const call: Called = {
				game,
				ply: index + 1,
				san: move.san,
				rating: ratings[move.color],
				loss: Number(verdict.loss.toFixed(3)),
				played: Number(verdict.playedPoints.toFixed(3)),
				...(verdict.brilliant ? { reason: verdict.brilliant.reason } : {}),
				...(verdict.brilliant
					? { offers: verdict.brilliant.offers.map((o) => `${o.shape}:${o.concession}`) }
					: {}),
			};
			t.distribution[verdict.quality] = (t.distribution[verdict.quality] ?? 0) + 1;
			const mark = entry.labels?.[String(index + 1)];
			if (mark !== undefined && mark !== "Brilliant")
				t.marks.push({ game, ply: index + 1, san: move.san, chesscom: mark, ours: verdict.quality });
			const badged = verdict.brilliant?.brilliant === true && verdict.quality !== "book";
			if (mark !== undefined && mark !== "Brilliant") {
				t.negativeClassified += 1;
				if (badged) {
					t.falsePositives += 1;
					t.negativeCalls.push(call);
				}
			}
			if (labelled) {
				t.labelledClassified += 1;
				t.labelledQualities[verdict.quality] = (t.labelledQualities[verdict.quality] ?? 0) + 1;
				const reason = verdict.brilliant?.reason ?? "no-offer";
				t.labelledReasons[reason] = (t.labelledReasons[reason] ?? 0) + 1;
				if (badged) {
					t.recalled += 1;
					t.recalledCalls.push(call);
				} else t.missed.push(call);
			} else {
				t.otherClassified += 1;
				if (badged) t.overCalls.push(call);
			}
		}
	}
	return t;
}
