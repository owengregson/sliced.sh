/**
 * Classification: a job's verdict from the frames held now, and the per-ply memory verdicts
 * depend on — the pitch of a mating sequence and the plies that passed the brilliant gates.
 */

import type { MoveQualityMark } from "@core/constants/move-quality";
import { BRILLIANT, MOVE_CLASSIFICATION, REVIEW } from "@core/constants/review";
import {
	classifyMoveQuality,
	forcedMoveVerdict,
	type MoveQualityVerdict,
	passedBrilliantGates,
} from "@core/engine/move-quality";
import type { Square } from "@typedefs/game";

import { type FrameStore, isFinal, type StoredFrame } from "./frame-store";
import { type MateNote, mateSemitones } from "./mate-pitch";
import { needsAfter, type VerdictJob } from "./verdict-job";

/**
 * What one attempt did: `decided` set the verdict, `deferred` needs the costly path admitted
 * first, `blocked` is still short of evidence (its blocker says why).
 */
export type ClassifyOutcome = "decided" | "deferred" | "blocked";

/**
 * A checkmate on the board, rated as the classifier rates one — `mate`, mate in 1, above the whole
 * ladder — without waiting for a review frame; nothing is graded, as for a forced move.
 */
function checkmateVerdict(): MoveQualityVerdict {
	return { ...forcedMoveVerdict(), quality: "mate", mateIn: 1 };
}

export interface VerdictClassifierDeps {
	frames: FrameStore;
	now: () => number;
	/** The rating a mover is graded at (chess.com's expected points depend on it). */
	rating?: ((mine: boolean) => number | undefined) | undefined;
}

export class VerdictClassifier {
	/** Per ply of a `mate` rating: its distance to mate and its sound's pitch (`mateSemitones`). */
	private readonly mateNotes = new Map<number, MateNote>();
	/** Plies whose move passed every brilliant gate (`BRILLIANT.sequencePlies` reads them). */
	private readonly sacrificePlies = new Set<number>();

	constructor(private readonly deps: VerdictClassifierDeps) {}

	/**
	 * Classify an open job. Board-known outcomes (checkmate, the only legal move) are cheap and
	 * always decided; a verdict from frames can run the costly sacrifice scans, so it is
	 * `deferred` unless `admitted`.
	 */
	classify(job: VerdictJob, admitted: boolean): ClassifyOutcome {
		if (job.checkmate) {
			// Checkmate is on the board: the last move of its sequence is rated, and sounds on the top
			// step, the moment it lands — also as the only legal move, or with no review frame ready.
			job.verdict = checkmateVerdict();
			this.noteMate(job);
			this.sacrificePlies.delete(job.move.ply);
			return "decided";
		}
		if (job.forced) {
			// The only legal move needs no review: its rating is known the moment it is played.
			job.verdict = forcedMoveVerdict();
			this.mateNotes.delete(job.move.ply);
			this.sacrificePlies.delete(job.move.ply);
			return "decided";
		}
		// Board-known outcomes above are cheap. Frames alone are not a cached verdict: producing
		// a new rating below can run the costly sacrifice scans, so it must wait out live input.
		if (!admitted) return "deferred";
		const { frames } = this.deps;
		const waited = job.landed !== null && this.deps.now() - job.landed.at >= REVIEW.landedWaitMs;
		const usable = (frame: StoredFrame | undefined): frame is StoredFrame =>
			frame !== undefined && (isFinal(frame) || (waited && frame.depth >= REVIEW.publishDepth));
		const before = frames.get(job.beforeKey);
		if (!usable(before)) {
			job.blocker = before ? "shallow" : "no-frame";
			return "blocked";
		}
		if (before.depth < MOVE_CLASSIFICATION.minDepth) {
			// A review that ran to its end without reaching a depth worth grading.
			job.blocker = "shallow";
			return "blocked";
		}
		if (job.book === undefined) return "blocked";
		const after = job.after ? frames.get(job.after.key) : undefined;
		const previous = job.previousKey ? frames.get(job.previousKey) : undefined;
		const verdict = classifyMoveQuality({
			fen: job.move.beforeFen,
			uci: job.move.uci,
			before,
			after: usable(after) ? after : undefined,
			previous: previous && previous.depth >= REVIEW.publishDepth ? previous : undefined,
			moverRating: this.deps.rating?.(job.mine),
			inBook: job.book,
			recentSacrifice: this.recentSacrifice(job.move.ply),
		});
		if (!verdict) {
			job.blocker = after ? "shallow" : "unscored";
			return "blocked";
		}
		// A shallow candidate is still being reviewed. Do not freeze an ordinary badge before
		// its tactical gates have enough evidence; a completed shallow search can still publish.
		if (
			verdict.brilliant?.reason === "insufficient-evidence" &&
			(!isFinal(before) || (needsAfter(job, frames) && !isFinal(after)))
		) {
			job.blocker = "shallow";
			return "blocked";
		}
		job.verdict = verdict;
		this.noteMate(job);
		if (passedBrilliantGates(verdict)) this.sacrificePlies.add(job.move.ply);
		else this.sacrificePlies.delete(job.move.ply);
		return "decided";
	}

	/** The chip for a decided job: its square, its quality and, for `mate`, its pitch. */
	mark(job: VerdictJob): { quality: MoveQualityMark } {
		const verdict = job.verdict;
		const square = job.move.uci.slice(2, 4) as Square;
		if (verdict?.quality !== "mate" || verdict.mateIn === null)
			return { quality: { square, quality: verdict?.quality ?? "good" } };
		const semitones = this.mateNotes.get(job.move.ply)?.semitones ?? mateSemitones(verdict.mateIn);
		return { quality: { square, quality: "mate", mateSemitones: semitones } };
	}

	/** A pitch that was never played: the mover's next move must not count it as tangential. */
	forgetMate(ply: number): void {
		this.mateNotes.delete(ply);
	}

	clear(): void {
		this.mateNotes.clear();
		this.sacrificePlies.clear();
	}

	/** The same side's move within `BRILLIANT.sequencePlies` before `ply` passed the brilliant gates. */
	private recentSacrifice(ply: number): boolean {
		for (let back = 2; back <= BRILLIANT.sequencePlies; back += 2)
			if (this.sacrificePlies.has(ply - back)) return true;
		return false;
	}

	/**
	 * Record a `mate` rating's pitch against the mover's previous move (two plies back):
	 * `mateSemitones` tells progress, a tangential move and a restart apart.
	 */
	private noteMate(job: VerdictJob): void {
		const mateIn = job.verdict?.quality === "mate" ? job.verdict.mateIn : null;
		if (mateIn === null) {
			this.mateNotes.delete(job.move.ply);
			return;
		}
		const previous = this.mateNotes.get(job.move.ply - 2);
		this.mateNotes.set(job.move.ply, { mateIn, semitones: mateSemitones(mateIn, previous) });
	}
}
