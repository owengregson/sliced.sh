/** The move-review engine's admission queue, boot and back-off (see `@service/review-engine`). */

import { REVIEW, reviewRetryDelayMs } from "@core/constants/review";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { defaultNow } from "@core/util/scheduler";
import { emptyResult, insertByRank, pendingHandle } from "@service/analysis/handles";
import { fullReviewReady, type ReviewBackend, remoteBackend } from "@service/review-engine/backend";
import { answersRequest, boundedRequest, reviewRank } from "@service/review-engine/request";
import type { EngineStatus } from "@typedefs/engine";

export interface ReviewEngineOptions {
	ensureHost(): Promise<void>;
	/** Search threads (`reviewThreads`); default `REVIEW.threadsMin`. */
	threads?: number;
	/** Injectable boundary for testing loading, crashes and concurrent requests. */
	createBackend?: () => ReviewBackend;
	now?: () => number;
}

interface ReviewJob {
	request: AnalysisRequest;
	handle: AnalysisHandle;
	inner: AnalysisHandle | null;
	cancelled: boolean;
	settled: boolean;
	start(inner: AnalysisHandle | null): void;
	finish(result: AnalysisResult): void;
}

function reviewJob(request: AnalysisRequest): ReviewJob {
	const pending = pendingHandle(request.id, async () => {
		if (job.settled) return;
		job.cancelled = true;
		if (job.inner) await job.inner.stop();
		else job.finish(emptyResult(request, "superseded"));
	});
	const job: ReviewJob = {
		request,
		inner: null,
		cancelled: false,
		settled: false,
		start: pending.start,
		finish: (value) => {
			if (job.settled) return;
			job.settled = true;
			pending.start(null);
			pending.settle(value);
		},
		handle: pending.handle,
	};
	return job;
}

export class ReviewEngine {
	private backend: ReviewBackend | null = null;
	private loading: Promise<void> | null = null;
	private loadAbort: AbortController | null = null;
	private readonly queue: ReviewJob[] = [];
	private readonly playOwners = new Set<string>();
	private active: ReviewJob | null = null;
	private disposed = false;
	private generation = 0;
	/** A failed boot is not retried before this time. */
	private unavailableUntil = 0;
	/** Boots and searches that failed in a row: the step of `REVIEW.retryBackoffMs` to wait. */
	private failures = 0;
	private readonly threads: number;
	private readonly now: () => number;

	constructor(private readonly options: ReviewEngineOptions) {
		this.threads = options.threads ?? REVIEW.threadsMin;
		this.now = options.now ?? defaultNow;
	}

	status(): EngineStatus | null {
		return this.backend?.status() ?? null;
	}

	/**
	 * Hold admission until every owner (normally a tab key) releases its play window. The active
	 * handle retains valid completed iterations and resolves superseded after cooperative stop;
	 * queued handles stay pending and retain their priority.
	 * Stopping is cooperative: do not launch another search until the old backend call settles.
	 */
	setPlayBusy(owner: string, busy: boolean): void {
		if (this.disposed) return;
		if (!busy) {
			if (this.playOwners.delete(owner) && this.playOwners.size === 0) this.pump();
			return;
		}
		if (this.playOwners.has(owner)) return;
		this.playOwners.add(owner);
		const active = this.active;
		// Preparation changes scheduling, not position/network provenance. Keep the slot until
		// cooperative stop settles and let consumers retain its last complete iteration.
		if (active && !active.cancelled)
			void active.handle.stop().catch((error: unknown) => {
				log.debug("review engine: preparation stop failed", { error: errorMessage(error) });
			});
	}

	warm(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("review engine disposed"));
		if (this.loading) return this.loading;
		if (this.now() < this.unavailableUntil)
			return Promise.reject(new Error("review engine unavailable; retrying later"));
		const backend =
			this.options.createBackend?.() ?? remoteBackend(this.options.ensureHost, this.threads);
		this.backend = backend;
		const abort = new AbortController();
		this.loadAbort = abort;
		this.loading = backend.warm(abort.signal).catch((error: unknown) => {
			if (this.backend === backend) {
				backend.dispose();
				this.backend = null;
				this.loading = null;
				this.loadAbort = null;
				if (!abort.signal.aborted) {
					const retryInMs = this.backOff();
					log.warn("review engine: the full build did not start", {
						error: errorMessage(error),
						failures: this.failures,
						retryInMs,
					});
				}
			}
			throw error;
		});
		return this.loading;
	}

	analyse(input: AnalysisRequest): AnalysisHandle {
		const request = boundedRequest(input);
		const job = reviewJob(request);
		if (this.disposed) {
			job.finish(emptyResult(request, "failed"));
			return job.handle;
		}
		// Equal priorities keep their order; only a more urgent request interrupts the running one.
		insertByRank(this.queue, job, (waiting) => reviewRank(waiting.request));
		if (this.queue.length > REVIEW.maxQueued) {
			const evicted = this.queue.pop();
			evicted?.finish(emptyResult(evicted.request, "superseded"));
		}
		if (this.active && reviewRank(request) < reviewRank(this.active.request))
			void this.active.handle.stop();
		this.pump();
		return job.handle;
	}

	/** Stop reviews and release the engine's memory; a later request boots it again. */
	release(): void {
		this.generation += 1;
		this.loadAbort?.abort();
		this.loadAbort = null;
		this.loading = null;
		const active = this.active;
		this.active = null;
		active?.finish(emptyResult(active.request, "superseded"));
		for (const job of this.queue) job.finish(emptyResult(job.request, "superseded"));
		this.queue.length = 0;
		this.backend?.dispose();
		this.backend = null;
	}

	dispose(): void {
		this.disposed = true;
		this.playOwners.clear();
		this.release();
	}

	private pump(): void {
		if (this.active || this.disposed || this.playOwners.size > 0) return;
		const job = this.queue.shift();
		if (!job) return;
		if (job.cancelled || job.settled) {
			this.pump();
			return;
		}
		this.active = job;
		const generation = this.generation;
		void this.run(job, generation).finally(() => {
			if (this.active === job) this.active = null;
			this.pump();
		});
	}

	private async run(job: ReviewJob, generation: number): Promise<void> {
		try {
			await this.warm();
			if (generation !== this.generation || job.cancelled || job.settled) return;
			const backend = this.backend;
			const status = backend?.status();
			// Between searches the host may still be reporting the last one; only a crash, a boot in
			// progress or a substituted network disqualify it.
			if (!backend || !fullReviewReady(status)) {
				// A host that stays crashed (its own reboots exhausted) never answers again.
				if (backend) this.discard(backend, "the full review network is unavailable");
				throw new Error("Full review engine is not ready");
			}
			const inner = backend.analyse(job.request);
			job.inner = inner;
			const current = () => generation === this.generation;
			const identity = status?.version;
			const sameNetwork = () => {
				const live = backend.status();
				return fullReviewReady(live) && live.version === identity;
			};
			const updates = async function* () {
				for await (const update of inner.updates) {
					if (!current()) return;
					if (!sameNetwork()) throw new Error("Review network changed during search");
					if (update.id !== job.request.id) throw new Error("Review iteration identity changed");
					yield update;
				}
			};
			job.start({ ...inner, updates: updates() });
			const result = await inner.result;
			if (!current()) return;
			if (!sameNetwork() || !answersRequest(job.request, result)) {
				this.discard(backend, "review network changed during search");
				job.finish(emptyResult(job.request, "failed"));
				return;
			}
			if (generation === this.generation) {
				// A failed search is a crash the engine may not recover from; a fresh boot always does.
				if (result.status === "failed") this.discard(backend, "a search failed");
				else this.failures = 0;
			}
			job.finish({ ...result, ...(job.cancelled ? { status: "superseded" } : {}) });
		} catch (error) {
			log.debug("review engine: search unavailable", { error: errorMessage(error) });
			job.finish(emptyResult(job.request, "failed"));
		} finally {
			if (!job.settled) job.finish(emptyResult(job.request, "superseded"));
		}
	}

	/** Drop a failed engine; the next request boots a fresh one once the back-off has passed. */
	private discard(backend: ReviewBackend, reason: string): void {
		if (this.backend !== backend) return;
		backend.dispose();
		this.backend = null;
		this.loading = null;
		this.loadAbort = null;
		const retryInMs = this.backOff();
		log.warn("review engine: dropping the engine", { reason, failures: this.failures, retryInMs });
	}

	/** One more failure in a row: hold off for its step of `REVIEW.retryBackoffMs`. */
	private backOff(): number {
		this.failures += 1;
		const wait = reviewRetryDelayMs(this.failures);
		this.unavailableUntil = this.now() + wait;
		return wait;
	}
}
