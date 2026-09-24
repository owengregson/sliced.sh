/**
 * tools/timing-calibration/heads/requests.ts — what the head is asked for each replayed row: the
 * session's timing context for the row (engine-free parts), the shipped `buildInputs` standardised
 * with a band set's scalers, and the cached answers' shape and file.
 */

import path from "node:path";
import { buildInputs } from "@core/timing/chessmimic-head";
import { type BandScalers, standardiseInputs } from "@core/timing/chessmimic-scalers";
import type { TimingContext } from "@core/timing/types";
import { type CorpusGame, DATA_DIR, PATHS, readJsonl, rowsOf, type TimingRow } from "../common";
import { SELECT_PATH, type Selection } from "../select";

export interface HeadRequest {
	id: string;
	band: string;
	ids: number[];
	rating: number;
	clocks: [number, number, number];
}

export interface HeadResult {
	id: string;
	band: string;
	probs: number[];
}

export function headsPath(tag = ""): string {
	return path.join(DATA_DIR, `heads${tag ? `.${tag}` : ""}.jsonl`);
}

/** The timing context the session builds for a replayed row (engine-free parts). */
export function rowContext(game: CorpusGame, row: TimingRow): TimingContext {
	return {
		fen: row.fen,
		ply: row.ply,
		moves: game.ucis.slice(0, row.ply),
		myColor: row.color,
		chosenMove: row.move,
		lines: [],
		evalBeforeOppMove: null,
		expectedOppReply: null,
		myClockMs: row.clockMs,
		oppClockMs: row.oppClockMs,
		baseSec: row.baseMs / 1000,
		incSec: row.incMs / 1000,
		oppThinkMsHistory: [],
		myThinkMsHistory: [],
		site: "chesscom",
		targetElo: row.rating,
		profile: "balanced",
		engineReady: true,
		inputMethod: "drag",
		autoQueen: true,
		nowMs: 0,
	};
}

/** The replayed rows of the selection, game by game. */
export async function* selectedRows(): AsyncGenerator<{ game: CorpusGame; rows: TimingRow[] }> {
	const selection = (await Bun.file(SELECT_PATH).json()) as Selection;
	const sides = new Map<string, Set<string>>();
	for (const s of selection.sides) {
		const set = sides.get(s.gameId) ?? new Set();
		set.add(s.color);
		sides.set(s.gameId, set);
	}
	for await (const g of readJsonl<CorpusGame>(PATHS.selectGames)) {
		const colors = sides.get(g.gameId);
		if (!colors) continue;
		yield { game: g, rows: rowsOf(g).filter((r) => colors.has(r.color) && !r.first) };
	}
}

export function requestFor(
	ctx: TimingContext,
	id: string,
	scalers: Readonly<Record<string, BandScalers>>
): HeadRequest {
	const inputs = buildInputs(ctx);
	const std = standardiseInputs(inputs, scalers[inputs.band]);
	return {
		id,
		band: inputs.band,
		ids: [...inputs.moveTokens, ...inputs.fenTokens],
		rating: std.scaledRating,
		clocks: std.clockFeatures,
	};
}

/**
 * The context the head is queried with. `withMove` is the upstream training contract (the timed
 * move as the last token of the 12-move window, `buildInputs(ctx, chosenMove)` on the finetune
 * branch), reproduced here by appending the move to the history the shipped encoder windows.
 */
export function queryContext(ctx: TimingContext, withMove: boolean): TimingContext {
	return withMove ? { ...ctx, moves: [...ctx.moves, ctx.chosenMove] } : ctx;
}
