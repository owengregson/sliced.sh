/**
 * Board effects and move ratings for every landed move (owner's briefs, 2026-09-13 / 2026-09-14).
 *
 * The effect list is pure chess and goes out the moment a move lands. The rating is chess.com's
 * Game Review verdict (`classifyMoveQuality`), and it rests **only** on review frames: complete
 * MultiPV searches by the dedicated full-network review engine (`ReviewEngine`), never on the
 * playing engine's strength-limited, shaped or shallow lines.
 *
 * On time, not after the fact. One frame per position answers both halves of a verdict, so the
 * reporter keeps a small store of frames and a single review search in flight, always on the most
 * urgent position still short of `REVIEW.targetDepth`:
 *
 *   0  a landed move's missing half — the position it was played from, or the position it made
 *   1  the current position (the side to move is thinking: it is the next move's "before")
 *   2  the result of our planned move (the opponent's next "before", searched while we wait out
 *      the human think time)
 *   3  the results of the likeliest replies (the current frame's top lines), once the current
 *      position is final — so the opponent's move and our answer to it are ready in advance
 *
 * A more urgent need stops the search in flight; what it completed stays in the store and the
 * position is picked up again later. A landed move publishes when its frames reach
 * `REVIEW.targetDepth`, or after `REVIEW.landedWaitMs` from frames at `REVIEW.publishDepth` — a
 * late rating carries only its chip, so it cannot delay or replay the rays.
 * `setPlayBusy` suspends search and classification only during foreground preparation. Input
 * activity gates classification separately; background search keeps producing frames. Heavy
 * classification yields between jobs and admits work before the caller's input lead boundary.
 * Existing verdicts, forced/checkmate marks and rays publish immediately. Two live plies get
 * board effects; older unresolved plies continue at low priority for the persistent move log.
 */

import { boardEffectsFor } from "@core/chess/board-effects";
import { loadPosition } from "@core/chess/fen";
import { playUci, uciToSan } from "@core/chess/san";
import { MOVE_QUALITY as Q } from "@core/constants/move-quality";
import { REVIEW } from "@core/constants/review";
import type { ReviewFrame } from "@core/engine/move-quality";
import { log } from "@core/logger";
import type { Square } from "@typedefs/game";

import { ClassificationQueue, nextClassification } from "./board-effects/classification-queue";
import { VerdictClassifier } from "./board-effects/classifier";
import { FrameStore } from "./board-effects/frame-store";
import { landedPlies, moveKey } from "./board-effects/keys";
import { ReviewSearchLoop } from "./board-effects/review-loop";
import { reviewWants, type Want } from "./board-effects/review-wants";
import type {
	Arrival,
	BoardEffectsReporterDeps,
	ClassifiedMove,
	DropReason,
	PlannedMove,
	ReviewedPosition,
	VerdictStats,
} from "./board-effects/types";
import { newVerdictJob, type VerdictJob } from "./board-effects/verdict-job";

export { landedPlies } from "./board-effects/keys";
export { type MateNote, matePitch, mateSemitones } from "./board-effects/mate-pitch";
export type {
	Arrival,
	BoardEffectsReporterDeps,
	ClassifiedMove,
	DropReason,
	LandedMove,
	PlannedMove,
	ReviewedPosition,
	ReviewSearcher,
	VerdictStats,
} from "./board-effects/types";

export class BoardEffectsReporter {
	private playBusy = false;
	private inputBusy = false;
	private availableUntil: number | null = null;
	private readonly frames = new FrameStore();
	private readonly classifier: VerdictClassifier;
	private readonly classifications: ClassificationQueue;
	private readonly reviews: ReviewSearchLoop;
	/** The last `MOVE_QUALITY.landedWindow` landed moves, oldest first. */
	private landed: VerdictJob[] = [];
	private readonly archive = new Map<number, VerdictJob>();
	private readonly annotated = new Map<number, VerdictJob>();
	/** The job started by `prepare()` for our planned move, waiting for it to land. */
	private prepared: VerdictJob | null = null;
	private current: ReviewedPosition | null = null;
	/** `report()` is assembling its first batch: a rating found now ships inside it. */
	private reporting = false;
	private readonly counters: VerdictStats = { delivered: 0, dropped: {} };
	private disposed = false;

	constructor(private readonly deps: BoardEffectsReporterDeps) {
		this.classifier = new VerdictClassifier({
			frames: this.frames,
			now: () => this.deps.now(),
			rating: (mine) => this.deps.rating?.(mine),
		});
		this.classifications = new ClassificationQueue({
			scheduler: deps.scheduler,
			admits: () => this.canClassify(),
			pick: (pending) => nextClassification(this.openJobs(), this.landed, pending),
			classify: (job) => this.resolve(job, true),
		});
		this.reviews = new ReviewSearchLoop({
			reviewer: () => this.deps.reviewer(),
			scheduler: deps.scheduler,
			now: () => this.deps.now(),
			admits: () => !this.disposed && !this.playBusy && this.chipsOn(),
			alive: () => !this.disposed,
			wants: () => this.wants(),
			frames: this.frames,
			store: (key, frame, done) => this.store(key, frame, done),
			refresh: () => this.resolveAll(),
			block: (reason) => {
				for (const job of this.landed) if (!job.verdict) job.blocker = reason;
			},
		});
	}

	/** Foreground preparation alone suspends search; preserve evidence from cooperative stop. */
	setPlayBusy(busy: boolean): void {
		if (this.disposed || this.playBusy === busy) return;
		this.playBusy = busy;
		if (busy) this.reviews.suspend();
		else {
			this.resolveAll();
			this.pump();
		}
	}

	/** Mouse-critical input blocks only synchronous classification, never background review. */
	setInputBusy(busy: boolean): void {
		if (this.disposed || this.inputBusy === busy) return;
		this.inputBusy = busy;
		if (!busy) this.resolveAll();
	}

	/** Absolute scheduler-clock lead boundary, already ahead of input; null is unlimited. */
	setAvailableUntil(until: number | null): void {
		if (this.disposed) return;
		this.availableUntil = until;
		this.classifications.schedule();
	}

	private canClassify(): boolean {
		return (
			!this.disposed &&
			!this.playBusy &&
			!this.inputBusy &&
			this.chipsOn() &&
			(this.availableUntil === null || this.deps.now() < this.availableUntil)
		);
	}

	/** `landedPlies`, reachable through the class for callers that only import it. */
	static landedPlies(
		beforeFen: string,
		last: { from: Square; to: Square },
		afterFen: string
	): string[] | null {
		return landedPlies(beforeFen, last, afterFen);
	}

	/** Chips delivered and landed moves that ended without one, by reason (for the tests). */
	stats(): VerdictStats {
		return { delivered: this.counters.delivered, dropped: { ...this.counters.dropped } };
	}

	/** The frame the reporter holds for `fen` (for the tests and the panel). */
	frameFor(fen: string): ReviewFrame | null {
		return this.frames.frameFor(fen);
	}

	/**
	 * The position on the board now. Reviewed right away: it is the "before" of the next move and
	 * the "after" of the one that produced it, whichever side is thinking.
	 */
	observe(position: ReviewedPosition): void {
		if (this.disposed || !this.chipsOn()) return;
		this.current = position;
		this.pump();
	}

	/** Recover validated history when attaching midgame or after missed position events. */
	backfill(position: ReviewedPosition, ply: number): void {
		if (!this.deps.annotate || !this.chipsOn() || this.disposed) return;
		const chess = loadPosition(position.history.fen);
		if (!chess) return;
		const start = ply - position.history.moves.length;
		const trail: string[] = [];
		for (const [i, uci] of position.history.moves.entries()) {
			const index = start + i;
			const beforeFen = chess.fen();
			if (!playUci(chess, uci)) return;
			if (
				!this.annotated.has(index) &&
				!this.archive.has(index) &&
				!this.landed.some((job) => job.move.ply === index)
			) {
				const move = {
					beforeFen,
					historyFen: position.history.fen,
					historyMoves: [...trail],
					uci,
					ply: index,
				};
				const job = this.open(moveKey(move), move, false);
				job.landed = { at: this.deps.now() - REVIEW.landedWaitMs };
				this.archive.set(index, job);
			}
			trail.push(uci);
		}
		this.resolveAll();
		this.pump();
	}

	/** Finish log reviews after game over, without speculative work or late board effects. */
	finish(): void {
		if (!this.deps.annotate) {
			this.cancel();
			return;
		}
		for (const job of this.landed) {
			if (job.closed) continue;
			this.noteDrop(job, job.blocker);
			this.archive.set(job.move.ply, job);
		}
		this.landed = [];
		if (this.prepared) this.close(this.prepared, null);
		this.prepared = null;
		this.current = null;
		this.resolveAll();
		this.pump();
	}

	/**
	 * Our next move is decided: open its verdict now and review the position it will produce
	 * while the hand waits out the think time, so the chip is ready when the move lands. A repeat
	 * for the same (position, move) is a no-op; a different plan replaces the previous one.
	 */
	prepare(planned: PlannedMove): void {
		if (this.disposed || !this.chipsOn()) return;
		const move: ClassifiedMove = {
			beforeFen: planned.beforeFen,
			historyFen: planned.history.fen,
			historyMoves: planned.history.moves,
			uci: planned.uci,
			ply: planned.ply,
			...(planned.inBook === undefined ? {} : { inBook: planned.inBook }),
		};
		const key = moveKey(move);
		if (this.prepared?.key !== key) {
			if (this.prepared) this.close(this.prepared, null);
			this.prepared = this.open(key, move, true);
		}
		this.resolveAll();
		this.pump();
	}

	/**
	 * Report the moves that produced the current position. Returns at once — one `effects`
	 * command per landed move goes out synchronously (the opponent's first), before any review
	 * bookkeeping. Ratings travel separately and never carry rays to replay.
	 */
	report(arrival: Arrival): void {
		if (this.disposed || arrival.moves.length === 0) return;
		const rays = this.raysOn();
		// No book lookup, review-job construction or classification may hold up the visual move.
		if (rays)
			for (const move of arrival.moves)
				this.deps.post({
					kind: "effects",
					effects: boardEffectsFor({ fen: move.beforeFen, uci: move.uci }),
					mine: move.mine,
				});
		if (!this.chipsOn()) {
			// Rays only: nothing is opened, so nothing is reviewed and no chip can follow later.
			this.cancel();
			return;
		}
		const at = this.deps.now();
		const batches: VerdictJob[] = [];
		for (const move of arrival.moves) {
			const key = moveKey(move);
			if (!this.shows(move.mine) && !this.deps.annotate) {
				// A side whose ratings are hidden: its effects go out, nothing is tracked or counted. A
				// plan for this very move (ours, under "theirs") has done its job — the position it
				// made was reviewed for the opponent's reply — and closes quietly.
				if (this.prepared?.key === key) {
					this.close(this.prepared, null);
					this.prepared = null;
				}
				continue;
			}
			const reviewed = this.annotated.get(move.ply);
			if (reviewed?.delivered) {
				continue;
			}
			const archived = this.archive.get(move.ply) ?? reviewed;
			let job: VerdictJob;
			if (this.prepared?.key === key && !this.prepared.closed) {
				// The move we planned is the move that landed: its rating is ready or on its way.
				job = this.prepared;
				this.prepared = null;
			} else if (archived?.key === key) {
				job = archived;
				job.closed = false;
				this.archive.delete(move.ply);
				job.mine = move.mine;
			} else {
				job = this.open(key, move, move.mine);
			}
			job.landed = { at };
			job.timer = this.deps.scheduler.setTimeout(() => {
				job.timer = null;
				this.resolve(job);
				this.pump();
			}, REVIEW.landedWaitMs);
			this.landed.push(job);
			batches.push(job);
		}
		if (this.prepared) {
			// A plan for a move we did not play: abandoned, never counted (it never landed).
			log.debug("board effects: prepared rating discarded, a different move landed", {
				planned: this.prepared.move.uci,
			});
			// Its pitch was never played: the next move of ours must not count it as tangential.
			this.classifier.forgetMate(this.prepared.move.ply);
			this.close(this.prepared, null);
			this.prepared = null;
		}
		this.trimLanded();
		// Resolve cheap/cached verdicts now; even these follow the already posted effects.
		this.reporting = true;
		try {
			this.resolveAll();
		} finally {
			this.reporting = false;
		}
		for (const job of batches) {
			if (job.verdict) this.publishAnnotation(job);
			if (job.verdict && !job.delivered && this.shows(job.mine)) {
				job.delivered = true;
				this.counters.delivered += 1;
				this.close(job, null);
				this.deps.post({ kind: "effects", effects: [], mine: job.mine, ...this.classifier.mark(job) });
			}
			// With the rays off a move whose chip is not decided yet posts nothing now: an empty batch
			// would draw nothing, and its chip, if one comes, follows on its own (`deliver`).
		}
		this.pump();
	}

	/**
	 * The board no longer carries the moves being rated (the game is over, the setting is off, a
	 * new game): stop the review search and orphan every rating, prepared or landed.
	 */
	cancel(): void {
		this.classifications.cancel();
		for (const job of this.archive.values()) this.close(job, null);
		this.archive.clear();
		this.annotated.clear();
		for (const job of this.landed) this.close(job, job.blocker);
		this.landed = [];
		if (this.prepared) this.close(this.prepared, null);
		this.prepared = null;
		this.current = null;
		this.reviews.cancel();
		this.frames.clear();
		this.classifier.clear();
	}

	/**
	 * A page where a game is played opened: start booting the review engine now, so the first
	 * rating does not also wait for the full network to load. Nothing is searched, and a boot that
	 * fails is left to the back-off.
	 */
	warm(): void {
		if (this.disposed || this.playBusy || !this.chipsOn() || this.reviews.backingOff()) return;
		const reviewer = this.deps.reviewer();
		if (!reviewer?.warm) return;
		reviewer.warm().catch((error: unknown) => {
			log.debug("board effects: the review engine did not warm up", { error });
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.cancel();
		this.disposed = true;
	}

	private chipsOn(): boolean {
		return this.deps.chips?.() !== false;
	}

	private raysOn(): boolean {
		return this.deps.rays?.() !== false;
	}

	/** Whether a move by this side (`mine` = the owner's) carries a chip (`chipsFor`). */
	private shows(mine: boolean): boolean {
		const side = this.deps.chipsFor?.() ?? "both";
		return side === "both" || (side === "mine") === mine;
	}

	/** A new job for `move`, reading its book membership in the background when it is unknown. */
	private open(key: string, move: ClassifiedMove, mine: boolean): VerdictJob {
		const job = newVerdictJob(key, move, mine);
		if (job.book === undefined) {
			const lookup = this.deps.bookMoves;
			if (!lookup) job.book = false;
			else
				void lookup(move.beforeFen).then(
					(moves) => {
						job.book = moves.includes(move.uci);
						this.resolve(job);
					},
					(error: unknown) => {
						log.debug("board effects: book lookup failed", { error });
						job.book = false;
						this.resolve(job);
					}
				);
		}
		return job;
	}

	/** Close a job; a landed move closing without a chip is logged and counted. */
	private close(job: VerdictJob, reason: DropReason | null): void {
		if (job.closed) return;
		job.closed = true;
		this.classifications.delete(job);
		if (job.timer !== null) {
			this.deps.scheduler.clearTimeout(job.timer);
			job.timer = null;
		}
		this.noteDrop(job, reason);
	}

	/** Losing board freshness does not discard the persistent review. Count it once. */
	private noteDrop(job: VerdictJob, reason: DropReason | null): void {
		if (job.boardDropped) return;
		// A side hidden since its move landed is not a missing chip: nothing is counted for it.
		if (reason === null || job.delivered || !job.landed || !this.shows(job.mine)) return;
		job.boardDropped = true;
		this.counters.dropped[reason] = (this.counters.dropped[reason] ?? 0) + 1;
		log.debug("board effects: no rating for the landed move", {
			uci: job.move.uci,
			ply: job.move.ply,
			mine: job.mine,
			reason,
		});
	}

	private openJobs(): VerdictJob[] {
		const jobs = this.landed.filter((job) => !job.closed && !job.verdict).reverse();
		if (this.prepared && !this.prepared.closed && !this.prepared.verdict) jobs.push(this.prepared);
		jobs.push(...[...this.archive.values()].filter((job) => !job.closed && !job.verdict));
		return jobs;
	}

	private trimLanded(): void {
		while (this.landed.length > Q.landedWindow) {
			const oldest = this.landed.shift();
			if (oldest && !oldest.closed && !oldest.verdict && this.deps.annotate) {
				this.noteDrop(oldest, oldest.blocker);
				this.archive.set(oldest.move.ply, oldest);
			} else if (oldest) this.close(oldest, oldest.blocker);
		}
	}

	private resolveAll(): void {
		for (const job of this.openJobs()) this.resolve(job);
	}

	/** Classify `job` from the frames held now; a landed job's rating is posted at once. */
	private resolve(job: VerdictJob, admitted = false): void {
		if (job.closed || job.verdict || this.disposed) return;
		const outcome = this.classifier.classify(job, admitted);
		if (outcome === "deferred") this.classifications.add(job);
		else if (outcome === "decided" && job.landed && !this.reporting) this.deliver(job);
	}

	private publishAnnotation(job: VerdictJob): void {
		if (!this.deps.annotate || !job.landed || !job.verdict || this.annotated.has(job.move.ply))
			return;
		const san = uciToSan(job.move.beforeFen, job.move.uci);
		if (!san) return;
		this.annotated.set(job.move.ply, job);
		this.deps.annotate({ ply: job.move.ply, san, quality: job.verdict.quality });
		this.archive.delete(job.move.ply);
	}

	/** A rating for a landed move that `report()` did not ship inside the first command. */
	private deliver(job: VerdictJob): void {
		if (job.closed || job.delivered || !job.landed || !job.verdict) return;
		this.publishAnnotation(job);
		if (!this.shows(job.mine)) {
			// The side's ratings were hidden after the move landed: no chip, and nothing counted.
			this.close(job, null);
			return;
		}
		const at = this.landed.indexOf(job);
		if (at < 0) {
			this.close(job, this.deps.annotate ? null : "stale");
			return;
		}
		const to = job.move.uci.slice(2, 4);
		for (const later of this.landed.slice(at + 1))
			if (later.move.uci.slice(2, 4) === to && later.delivered) {
				// A later move on the same square already has its chip there: an older one would cover
				// it. Until then the chips go out in the order the moves landed (a premove recapture).
				this.close(job, "stale");
				return;
			}
		job.delivered = true;
		this.counters.delivered += 1;
		this.close(job, null);
		// Effects were sent on arrival. A late badge cannot replay rays after another move landed.
		this.deps.post({ kind: "effects", effects: [], mine: job.mine, ...this.classifier.mark(job) });
	}

	/** Every position worth reviewing now, most urgent first (`reviewWants`). */
	private wants(): Want[] {
		return reviewWants({
			landed: this.landed,
			current: this.current,
			prepared: this.prepared,
			archive: this.archive.values(),
			frames: this.frames,
			tracked: (job) => this.shows(job.mine) || this.deps.annotate !== undefined,
		});
	}

	private pump(): void {
		this.reviews.pump();
	}

	/** Keep a review frame; eviction spares every wanted position and every open Miss reference. */
	private store(key: string, frame: ReviewFrame, done: boolean): void {
		this.frames.store(key, frame, done, () => {
			const keep = new Set(this.wants().map((want) => want.key));
			for (const job of this.openJobs()) if (job.previousKey) keep.add(job.previousKey);
			return keep;
		});
	}
}
