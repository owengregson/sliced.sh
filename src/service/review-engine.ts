/**
 * The move-review engine (owner, 2026-09-14): one lazily booted Stockfish 19 **full** instance in
 * the offscreen document, on its own port (`PORT_NAMES.reviewEngine`), shared by every session's
 * `BoardEffectsReporter`.
 *
 * Its own WASM memory, transposition table and UCI stream isolate playing-engine options and
 * commands, but both engines still compete for CPU and memory bandwidth. `setPlayBusy` pauses
 * review admission during foreground preparation without unloading the warm engine. Thinking and
 * mouse activity leave background search running; the reporter separately admits classification. It never
 * falls back to the small network (the offscreen host refuses to for this port) and never limits
 * its strength — a rating is only as good as the evaluation behind it.
 *
 * One search at a time from a small priority queue (`move` > `ponder` > `panel`, the reporter's
 * urgency); a more urgent request stops the running one, which still answers with the deepest
 * iteration it completed. A failed boot or a failed search drops the engine and backs off along
 * `REVIEW.retryBackoffMs` (a second at first, longer only while it keeps failing) instead of
 * retrying on every request. `release()` frees the engine when ratings are switched off; the next
 * request boots it again.
 */

import { ENGINE_FILES } from "@core/constants/engine-files";
import { PORT_NAMES } from "@core/constants/ports";
import { REVIEW, reviewRetryDelayMs } from "@core/constants/review";
import { RemoteEngine } from "@core/engine/remote-engine";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import { UciEngine } from "@core/engine/uci-client";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { defaultNow } from "@core/util/scheduler";
import type { EngineStatus } from "@typedefs/engine";

export interface ReviewBackend {
	warm(signal: AbortSignal): Promise<void>;
	analyse(request: AnalysisRequest): AnalysisHandle;
	status(): EngineStatus;
	dispose(): void;
}

export interface ReviewEngineOptions {
	ensureHost(): Promise<void>;
	/** Search threads (`reviewThreads`); default `REVIEW.threadsMin`. */
	threads?: number;
	/** Injectable boundary for testing loading, crashes and concurrent requests. */
	createBackend?: () => ReviewBackend;
	now?: () => number;
}

/** Review's independent thread cap; this does not reserve cores for the playing engine. */
export function reviewThreads(hardwareConcurrency: number | undefined): number {
	const cores =
		hardwareConcurrency !== undefined && Number.isFinite(hardwareConcurrency)
			? hardwareConcurrency
			: REVIEW.threadsMin;
	return Math.max(REVIEW.threadsMin, Math.min(REVIEW.threadsMax, Math.floor(cores / 2)));
}

/** Verify the actual loaded network, not merely the requested variant. */
export function fullReviewReady(status: EngineStatus | null | undefined): boolean {
	return (
		!!status &&
		status.variant === "full" &&
		status.fallbackFrom === undefined &&
		status.error === undefined &&
		(status.state === "ready" || status.state === "searching") &&
		status.nnue.length === ENGINE_FILES.full.nnue.length &&
		ENGINE_FILES.full.nnue.every((name) => status.nnue.includes(name))
	);
}

function remoteBackend(ensureHost: () => Promise<void>, threads: number): ReviewBackend {
	const transport = new RemoteEngine({
		ensureHost,
		portName: PORT_NAMES.reviewEngine,
		variant: "full",
		threads,
	});
	const engine = new UciEngine(transport);
	return {
		async warm(signal) {
			await transport.configureAndWait("full", threads, signal);
			if (signal.aborted) throw new Error("review engine loading cancelled");
			const status = transport.status();
			if (status.variant !== "full" || status.fallbackFrom || status.error)
				throw new Error(status.error ?? "Full review engine unavailable");
			await engine.init();
			if (signal.aborted) throw new Error("review engine loading cancelled");
			await engine.setOptions({
				Threads: threads,
				Hash: REVIEW.hashMb,
				UCI_LimitStrength: false,
				"Skill Level": 20,
				UCI_ShowWDL: true,
				Ponder: false,
			});
			if (!fullReviewReady(transport.status())) throw new Error("Full review network not ready");
		},
		analyse: (request) => engine.analyse(request),
		status: () => transport.status(),
		dispose() {
			engine.dispose();
			// The review port's disconnect handler quits its host and frees its WASM memory.
			transport.dispose();
		},
	};
}

/** At most `REVIEW`'s shape: MultiPV, depth and movetime are capped, never raised. */
function boundedRequest(input: AnalysisRequest): AnalysisRequest {
	const cap = (value: number | undefined, max: number): number =>
		typeof value === "number" && Number.isFinite(value)
			? Math.max(1, Math.min(max, Math.round(value)))
			: max;
	return {
		id: input.id,
		fen: input.fen,
		...(input.moves ? { moves: [...input.moves] } : {}),
		multiPv: cap(input.multiPv, REVIEW.multiPv),
		limit: {
			depth: cap(input.limit.depth, REVIEW.targetDepth),
			movetimeMs: cap(input.limit.movetimeMs, REVIEW.movetimeMs),
		},
		priority: input.priority ?? "panel",
	};
}

function emptyResult(request: AnalysisRequest, status: AnalysisResult["status"]): AnalysisResult {
	return {
		id: request.id,
		request,
		status,
		bestmove: null,
		final: { id: request.id, depth: 0, lines: [], nodes: 0, nps: 0, timeMs: 0, complete: false },
	};
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

function rank(request: AnalysisRequest): number {
	return request.priority === "move" ? 0 : request.priority === "ponder" ? 1 : 2;
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
		let begin: (inner: AnalysisHandle | null) => void = () => {};
		const started = new Promise<AnalysisHandle | null>((resolve) => {
			begin = resolve;
		});
		let resolveResult: (result: AnalysisResult) => void = () => {};
		const result = new Promise<AnalysisResult>((resolve) => {
			resolveResult = resolve;
		});
		async function* updates(): AsyncGenerator<AnalysisUpdate> {
			const inner = await started;
			if (inner) yield* inner.updates;
		}
		const job: ReviewJob = {
			request,
			inner: null,
			cancelled: false,
			settled: false,
			start: begin,
			finish: (value) => {
				if (job.settled) return;
				job.settled = true;
				begin(null);
				resolveResult(value);
			},
			handle: {
				id: request.id,
				updates: updates(),
				result,
				stop: async () => {
					if (job.settled) return;
					job.cancelled = true;
					if (job.inner) await job.inner.stop();
					else job.finish(emptyResult(request, "superseded"));
				},
			},
		};
		if (this.disposed) {
			job.finish(emptyResult(request, "failed"));
			return job.handle;
		}
		// Equal priorities keep their order; only a more urgent request interrupts the running one.
		const at = this.queue.findIndex((waiting) => rank(waiting.request) > rank(request));
		if (at < 0) this.queue.push(job);
		else this.queue.splice(at, 0, job);
		if (this.queue.length > REVIEW.maxQueued) {
			const evicted = this.queue.pop();
			evicted?.finish(emptyResult(evicted.request, "superseded"));
		}
		if (this.active && rank(request) < rank(this.active.request)) void this.active.handle.stop();
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
			if (
				!sameNetwork() ||
				result.id !== job.request.id ||
				result.final.id !== job.request.id ||
				result.request.fen !== job.request.fen ||
				(result.request.moves ?? []).join(" ") !== (job.request.moves ?? []).join(" ")
			) {
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
