/**
 * Which positions the reporter wants reviewed, most urgent first (0 = most):
 *
 *   0  a landed move's missing half — the position it was played from, or the position it made
 *   1  the current position (the side to move is thinking: it is the next move's "before")
 *   2  the result of our planned move (the opponent's next "before")
 *   3  archived moves still waiting for the persistent move log
 *   4  the results of the likeliest replies (the current frame's top lines), once the current
 *      position is final
 */

import { applyMoves, legalMoves } from "@core/chess/san";
import { REVIEW } from "@core/constants/review";
import { rankedLines } from "@core/strength/quality";

import { type FrameStore, isFinal } from "./frame-store";
import { reviewKey } from "./keys";
import type { ReviewedPosition } from "./types";
import { needsAfter, type VerdictJob } from "./verdict-job";

/** A position the reporter wants searched, and how urgently (0 = most). */
export interface Want {
	key: string;
	root: string;
	moves: string[];
	urgency: number;
}

export interface WantSources {
	/** Landed moves, oldest first. */
	landed: readonly VerdictJob[];
	current: ReviewedPosition | null;
	prepared: VerdictJob | null;
	archive: Iterable<VerdictJob>;
	frames: FrameStore;
	/** A landed move's verdict is still wanted (its side shows chips, or the log records it). */
	tracked(job: VerdictJob): boolean;
}

/** Every position worth reviewing now, most urgent first (duplicates keep the first). */
export function reviewWants(sources: WantSources): Want[] {
	const { frames } = sources;
	const out: Want[] = [];
	const seen = new Set<string>();
	const add = (key: string, root: string, moves: readonly string[], urgency: number): void => {
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ key, root, moves: [...moves], urgency });
	};
	const halves = (job: VerdictJob, urgency: number, always: boolean): void => {
		add(job.beforeKey, job.move.historyFen, job.move.historyMoves, urgency);
		if (job.after && (always || needsAfter(job, frames)))
			add(job.after.key, job.move.historyFen, [...job.move.historyMoves, job.move.uci], urgency);
	};
	for (const job of [...sources.landed].reverse())
		if (!job.closed && !job.verdict && sources.tracked(job)) halves(job, 0, false);
	const current = sources.current;
	if (current) add(reviewKey(current.fen), current.history.fen, current.history.moves, 1);
	const prepared = sources.prepared;
	if (prepared && !prepared.closed) halves(prepared, 2, true);
	for (const job of sources.archive) if (!job.closed && !job.verdict) halves(job, 3, false);
	if (current) {
		const frame = frames.get(reviewKey(current.fen));
		if (isFinal(frame) && frame)
			for (const line of rankedLines(frame.lines).slice(0, REVIEW.speculativeReplies)) {
				const reply = line.pvUci[0];
				const next = reply ? applyMoves(current.fen, [reply]) : null;
				if (reply && next && legalMoves(next).length > 0)
					add(reviewKey(next), current.history.fen, [...current.history.moves, reply], 4);
			}
	}
	return out;
}
