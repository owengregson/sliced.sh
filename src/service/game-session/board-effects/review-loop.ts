/**
 * The review search loop: a single review search in flight, always on the most urgent position
 * still short of `REVIEW.targetDepth`. A more urgent need stops the search in flight; what it
 * completed stays in the store and the position is picked up again later. A failing engine is
 * retried along `REVIEW.retryBackoffMs`.
 */

import { REVIEW, reviewRetryDelayMs } from "@core/constants/review";
import type { ReviewFrame } from "@core/engine/move-quality";
import type { AnalysisHandle, AnalysisPriority, AnalysisRequest } from "@core/engine/types";
import { log } from "@core/logger";
import { newId } from "@core/util/ids";
import type { Scheduler } from "@core/util/scheduler";

import { type FrameStore, isFinal } from "./frame-store";
import type { Want } from "./review-wants";
import type { DropReason, ReviewSearcher } from "./types";

interface ActiveSearch {
	key: string;
	urgency: number;
	handle: AnalysisHandle;
	stopping: boolean;
}

/** What the loop reads from, and reports to, the reporter that owns it. */
export interface ReviewLoopHost {
	reviewer(): ReviewSearcher | null;
	scheduler: Scheduler;
	now(): number;
	/** Searching is allowed now: not disposed, not suspended for play, chips on. */
	admits(): boolean;
	/** The reporter is still alive (a late answer after dispose is dropped). */
	alive(): boolean;
	wants(): Want[];
	frames: FrameStore;
	/** Keep a frame the search produced. */
	store(key: string, frame: ReviewFrame, done: boolean): void;
	/** New frames arrived: re-evaluate every open verdict. */
	refresh(): void;
	/** Why the landed moves still waiting for a verdict are stuck. */
	block(reason: DropReason): void;
}

export class ReviewSearchLoop {
	private generation = 0;
	private active: ActiveSearch | null = null;
	/** After a failed search, nothing is issued before this time (and a timer pumps then). */
	private retryAt = 0;
	private retryTimer: unknown = null;
	/** Review searches that failed in a row: the step of `REVIEW.retryBackoffMs` to wait. */
	private failures = 0;

	constructor(private readonly host: ReviewLoopHost) {}

	/** Still backing off after a failure: nothing may be issued (or warmed) yet. */
	backingOff(): boolean {
		return this.host.now() < this.retryAt;
	}

	/** Foreground preparation: stop the search in flight cooperatively, keeping what it found. */
	suspend(): void {
		const active = this.active;
		if (active && !active.stopping) {
			active.stopping = true;
			void active.handle.stop().catch((error: unknown) => {
				log.debug("board effects: preparation stop failed", { error });
			});
		}
	}

	/** Forget the search in flight and any back-off; late answers are discarded. */
	cancel(): void {
		this.generation += 1;
		const active = this.active;
		this.active = null;
		if (active) void active.handle.stop();
		if (this.retryTimer !== null) this.host.scheduler.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.retryAt = 0;
	}

	/** Keep the one review search on the most urgent position that is not final yet. */
	pump(): void {
		const host = this.host;
		if (!host.admits()) return;
		const reviewer = host.reviewer();
		if (!reviewer) {
			host.block("no-reviewer");
			return;
		}
		if (host.now() < this.retryAt) return;
		const wants = host.wants().filter((want) => !isFinal(host.frames.get(want.key)));
		const next = wants[0];
		const active = this.active;
		if (active) {
			if (active.stopping) return;
			const wanted = wants.find((want) => want.key === active.key);
			if (wanted && !(next && next.urgency < active.urgency && next.key !== active.key)) {
				active.urgency = wanted.urgency;
				return;
			}
			active.stopping = true;
			void active.handle.stop();
			return;
		}
		if (next) this.issue(reviewer, next);
	}

	private issue(reviewer: ReviewSearcher, want: Want): void {
		const priority: AnalysisPriority =
			want.urgency === 0 ? "move" : want.urgency === 1 ? "ponder" : "panel";
		const req: AnalysisRequest = {
			id: newId(),
			fen: want.root,
			...(want.moves.length > 0 ? { moves: want.moves } : {}),
			multiPv: REVIEW.multiPv,
			limit: { depth: REVIEW.targetDepth, movetimeMs: REVIEW.movetimeMs },
			priority,
		};
		let handle: AnalysisHandle;
		try {
			handle = reviewer.analyse(req);
		} catch (error) {
			log.debug("board effects: review refused", { error });
			this.failed();
			return;
		}
		const active: ActiveSearch = { key: want.key, urgency: want.urgency, handle, stopping: false };
		const generation = this.generation;
		this.active = active;
		void this.follow(active);
		handle.result.then(
			(result) => {
				if (this.active === active) this.active = null;
				if (!this.host.alive() || generation !== this.generation) return;
				if (result.status === "failed") {
					this.failed();
					return;
				}
				this.failures = 0;
				if (
					result.final.complete &&
					result.id === req.id &&
					result.final.id === req.id &&
					result.request.fen === req.fen &&
					(result.request.moves ?? []).join(" ") === (req.moves ?? []).join(" ")
				)
					this.host.store(active.key, result.final, result.status === "complete" && !active.stopping);
				this.host.refresh();
				this.pump();
			},
			(error: unknown) => {
				if (this.active === active) this.active = null;
				log.debug("board effects: review failed", { error });
				if (this.host.alive() && generation === this.generation) this.failed();
			}
		);
	}

	/** Every complete iteration of the search in flight goes into the store as it arrives. */
	private async follow(active: ActiveSearch): Promise<void> {
		try {
			for await (const update of active.handle.updates) {
				if (!this.host.alive() || this.active !== active) return;
				if (!update.complete || update.id !== active.handle.id) continue;
				this.host.store(active.key, update, false);
				this.host.refresh();
				this.pump();
			}
		} catch (error) {
			log.debug("board effects: review updates ended", { error });
		}
	}

	/**
	 * The review engine could not answer: mark the waiting ratings, back off along
	 * `REVIEW.retryBackoffMs` (longer only while it keeps failing), try again then.
	 */
	private failed(): void {
		this.host.block("failed");
		this.failures += 1;
		const wait = reviewRetryDelayMs(this.failures);
		this.retryAt = this.host.now() + wait;
		if (this.retryTimer !== null) this.host.scheduler.clearTimeout(this.retryTimer);
		this.retryTimer = this.host.scheduler.setTimeout(() => {
			this.retryTimer = null;
			this.pump();
		}, wait);
	}
}
