/** Owns engine options, network routing, and priority-aware cached analysis. */

import { LIMITS } from "@core/constants/limits";
import { SEARCH_BUDGET } from "@core/constants/search";
import { TIMINGS } from "@core/constants/timings";
import type { AnalysisCache } from "@core/engine/analysis-cache";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import {
	type EngineOptions,
	type OptionsEnv,
	optionsForSettings,
	requestEloForTarget,
	variantForSettings,
} from "@core/engine/options";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
	EngineInfo,
	EngineState,
} from "@core/engine/types";
import { FEATURE_DEPTH, type UciEngine } from "@core/engine/uci-client";
import { log } from "@core/logger";
import { newId } from "@core/util/ids";
import type { EngineVariant } from "@typedefs/engine";
import type { Settings } from "@typedefs/settings";

export interface EngineControllerDeps {
	getSettings(): Promise<Settings>;
	/** Returns unsubscribe. */
	onSettingsChanged(cb: (settings: Settings) => void): () => void;
	env: OptionsEnv;
	/** No cache → every request reaches the engine. */
	cache?: AnalysisCache | undefined;
	now?: () => number;
	/**
	 * Minimum `final.depth` for a cache hit on a depth-less, non-infinite request
	 * (default `FEATURE_DEPTH`, the timing model's `D_f`). Explicit depth ceilings
	 * remain authoritative even when lower than the feature depth.
	 */
	cacheMinDepth?: number;
	/** Resolves only when the requested variant and its verified networks are loaded. */
	configureVariant?: (variant: EngineVariant, threads: number, signal: AbortSignal) => Promise<void>;
	/** Actual host variant can differ after an acknowledged Full-to-Small crash fallback. */
	getLoadedVariant?: () => EngineVariant | undefined;
}

export interface EngineControllerStatus {
	state: EngineState;
	/** Options last confirmed by the engine (`null` until the first apply). */
	options: EngineOptions | null;
	/** A settings change is waiting for the engine to go idle (or to be initialised). */
	pendingOptions: boolean;
	optionsAppliedAt: number | null;
	/** Queued or running requests issued through this controller. */
	inFlight: number;
	cacheSize: number;
	gameId: string | null;
}

/** Keys of `EngineOptions` whose value differs between `next` and `prev` (all of them when `prev` is undefined). */
function diffOptions(next: EngineOptions, prev: EngineOptions | undefined): Partial<EngineOptions> {
	if (!prev) return { ...next };
	const out: Partial<EngineOptions> = {};
	for (const key of Object.keys(next) as Array<keyof EngineOptions>) {
		const value = next[key];
		if (value !== undefined && prev[key] !== value) Object.assign(out, { [key]: value });
	}
	return out;
}

/** A settled handle: `updates` yields the final frame once, `stop` is a no-op. */
function cachedHandle(req: AnalysisRequest, hit: AnalysisResult): AnalysisHandle {
	const final: AnalysisUpdate = { ...hit.final, id: req.id };
	const result: AnalysisResult = { ...hit, id: req.id, final, status: "complete", request: req };
	if (hit.atFeatureDepth) result.atFeatureDepth = { ...hit.atFeatureDepth, id: req.id };
	async function* once(): AsyncGenerator<AnalysisUpdate> {
		yield final;
	}
	return {
		id: req.id,
		updates: once(),
		result: Promise.resolve(result),
		stop: () => Promise.resolve(),
	};
}

interface RoutedAnalysis {
	req: AnalysisRequest;
	handle: AnalysisHandle;
	inner: AnalysisHandle | null;
	cancelled: boolean;
	superseded: boolean;
	start(handle: AnalysisHandle | null): void;
	settle(result: AnalysisResult): void;
}

function priority(req: AnalysisRequest): number {
	return req.priority === "panel" ? 2 : req.priority === "ponder" ? 1 : 0;
}

function emptyResult(req: AnalysisRequest, status: AnalysisResult["status"]): AnalysisResult {
	return {
		id: req.id,
		bestmove: null,
		request: req,
		status,
		final: { id: req.id, depth: 0, lines: [], nodes: 0, nps: 0, timeMs: 0, complete: false },
	};
}

export class EngineController {
	/** Resolves once the initial settings have been read (and applied, or left pending). */
	readonly ready: Promise<void>;
	private settings: Settings | undefined;
	private wanted: EngineOptions | undefined;
	private applied: EngineOptions | undefined;
	private appliedAt: number | null = null;
	private pending = false;
	private applying = false;
	/** `newGame()` holds the settlement-triggered apply until `ucinewgame` is through. */
	private suspendApply = false;
	private disposed = false;
	private gameId: string | null = null;
	private readonly inFlight = new Set<AnalysisHandle>();
	private readonly cache: AnalysisCache | undefined;
	private readonly env: OptionsEnv;
	private readonly now: () => number;
	private readonly cacheMinDepth: number;
	private readonly unsubscribe: () => void;
	private readonly configureVariant: EngineControllerDeps["configureVariant"];
	private readonly getLoadedVariant: EngineControllerDeps["getLoadedVariant"];
	private lastLoadedVariant: EngineVariant | undefined;
	private configuredVariant: EngineVariant | null = null;
	private loadingVariant: EngineVariant | null = null;
	private variantChange: Promise<void> | null = null;
	private variantAbort: AbortController | null = null;
	private configuredInfo: EngineInfo | null = null;
	private gameChange: Promise<void> | null = null;
	private resettingGameId: string | undefined;
	private readonly routedQueue: RoutedAnalysis[] = [];
	private routedActive: RoutedAnalysis | null = null;
	/** Keep warming the admitted target even if its bounded request expires. */
	private routeRequest: AnalysisRequest | null = null;
	private cacheGeneration = 0;

	constructor(
		private readonly engine: UciEngine,
		deps: EngineControllerDeps
	) {
		this.cache = deps.cache;
		this.env = deps.env;
		this.now = deps.now ?? (() => Date.now());
		this.cacheMinDepth = deps.cacheMinDepth ?? FEATURE_DEPTH;
		this.configureVariant = deps.configureVariant;
		this.getLoadedVariant = deps.getLoadedVariant;
		this.unsubscribe = deps.onSettingsChanged((s) => this.onSettings(s));
		this.ready = deps.getSettings().then(
			(s) => {
				// A change event that raced the initial read is newer than the read.
				if (this.settings === undefined) this.onSettings(s);
			},
			(err: unknown) => {
				log.warn("engine-controller: initial settings read failed", err);
			}
		);
	}

	/** `engine.init()`, then the options from settings (waits for the initial read). */
	async init(): Promise<EngineInfo> {
		await this.ready;
		if (this.configureVariant) {
			if (this.needsVariantChange()) this.startVariantChange();
			await this.variantChange;
			if (this.configuredInfo && this.engine.state() === "idle") return this.configuredInfo;
		}
		const info = await this.engine.init();
		await this.applyOptions();
		return info;
	}

	/** Cache hit → a settled handle; otherwise queued on the engine at `req.priority`. */
	analyse(req: AnalysisRequest): AnalysisHandle {
		if (this.configureVariant) return this.enqueueRouted(req);
		if (this.gameChange) return this.afterVariantChange(req, this.gameChange);
		const hit = this.lookup(req);
		if (hit) {
			log.debug("engine-controller: cache hit", req.id, req.priority ?? "move");
			return cachedHandle(req, hit);
		}
		const handle = this.engine.analyse(req);
		this.track(handle);
		return handle;
	}

	/** Bounded ponder; session callers pass their active target instead of the stored fixed rating. */
	ponder(
		fen: string,
		moves: string[],
		multiPv: number,
		targetElo = this.settings?.strength.targetElo ?? LIMITS.eloMax
	): AnalysisHandle {
		const elo = requestEloForTarget(targetElo);
		return this.analyse({
			id: newId(),
			fen,
			moves,
			multiPv,
			targetElo,
			limit: { depth: automaticDepthForElo(targetElo), movetimeMs: TIMINGS.ponderMaxMs },
			...(elo === undefined ? {} : { elo }),
			priority: "ponder",
		});
	}

	/**
	 * `ucinewgame` once per game: a repeated `gameId` is a no-op. Every request
	 * in flight is stopped first (the client refuses `ucinewgame` mid-search);
	 * a deferred settings change is applied afterwards.
	 */
	newGame(gameId?: string): Promise<void> {
		if (this.gameChange && gameId !== undefined && gameId === this.resettingGameId)
			return this.gameChange;
		if (!this.gameChange && gameId !== undefined && gameId === this.gameId) return Promise.resolve();
		const previous = this.gameChange;
		const run = async (): Promise<void> => {
			this.suspendApply = true;
			try {
				await Promise.all([...this.inFlight].map((h) => h.stop()));
				if (previous) await previous.catch(() => {});
				await this.variantChange;
				await this.engine.newGame();
				this.gameId = gameId ?? null;
			} finally {
				this.suspendApply = false;
			}
			await this.applyOptions();
		};
		const operation = run();
		this.gameChange = operation;
		this.resettingGameId = gameId;
		const clear = (): void => {
			if (this.gameChange !== operation) return;
			this.gameChange = null;
			this.resettingGameId = undefined;
			this.pumpRouted();
		};
		void operation.then(clear, clear);
		return operation;
	}

	/** `UCI_Elo` the engine runs with (from the applied options, else the wanted ones). */
	engineElo(): number | undefined {
		const options = this.applied ?? this.wanted;
		return options?.UCI_LimitStrength ? options.UCI_Elo : undefined;
	}

	/** The last settings seen (initial read or change event). */
	currentSettings(): Settings | undefined {
		return this.settings;
	}

	status(): EngineControllerStatus {
		return {
			state: this.engine.state(),
			options: this.applied ? { ...this.applied } : null,
			pendingOptions: this.pending,
			optionsAppliedAt: this.appliedAt,
			inFlight: this.inFlight.size,
			cacheSize: this.cache?.size ?? 0,
			gameId: this.gameId,
		};
	}

	/** Unsubscribes from settings; the engine (injected) is the owner's to dispose. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.variantAbort?.abort();
		this.unsubscribe();
		for (const handle of this.inFlight) void handle.stop().catch(() => {});
		this.inFlight.clear();
	}

	private onSettings(settings: Settings): void {
		if (this.disposed) return;
		this.settings = settings;
		this.wanted = optionsForSettings(settings, this.env);
		this.pending = true;
		if (this.needsVariantChange() || this.variantChange) {
			if (this.loadingVariant !== this.desiredVariant()) this.variantAbort?.abort();
			this.startVariantChange();
			return;
		}
		void this.applyOptions();
	}

	private desiredVariant(): EngineVariant | null {
		return this.settings ? variantForSettings(this.settings, this.routeRequest?.targetElo) : null;
	}

	private needsVariantChange(): boolean {
		return (
			!this.disposed &&
			this.configureVariant !== undefined &&
			this.settings !== undefined &&
			this.desiredVariant() !== this.configuredVariant
		);
	}

	private startVariantChange(): void {
		if (this.variantChange || !this.configureVariant) return;
		const configure = this.configureVariant;
		const run = async (): Promise<void> => {
			while (this.settings && this.wanted && !this.disposed) {
				const variant = this.desiredVariant();
				if (!variant) return;
				const wanted = this.wanted;
				const ac = new AbortController();
				this.variantAbort = ac;
				this.loadingVariant = variant;
				// Only the native handle may be stopped here: queued wrappers await this load.
				await this.routedActive?.inner?.stop();
				if (ac.signal.aborted) continue;
				this.cacheGeneration++;
				this.cache?.clear();
				this.configuredVariant = null;
				try {
					this.configuredInfo = await this.engine.reconfigure(
						() => configure(variant, wanted.Threads, ac.signal),
						wanted
					);
				} catch (error) {
					if (ac.signal.aborted && !this.disposed) continue;
					this.pending = true;
					throw error;
				}
				this.configuredVariant = variant;
				this.applied = wanted;
				this.appliedAt = this.now();
				if (this.desiredVariant() === variant && !ac.signal.aborted) {
					this.pending = this.wanted !== wanted;
					return;
				}
			}
		};
		const operation = run();
		this.variantChange = operation;
		const clear = (): void => {
			if (this.variantChange !== operation) return;
			this.variantChange = null;
			this.variantAbort = null;
			this.loadingVariant = null;
		};
		void operation.then(
			() => {
				clear();
				if (this.pending) void this.applyOptions();
			},
			(error: unknown) => {
				clear();
				log.warn("engine-controller: network configuration failed", String(error));
			}
		);
	}

	private enqueueRouted(req: AnalysisRequest): AnalysisHandle {
		let start: (handle: AnalysisHandle | null) => void = () => {};
		let settle: (result: AnalysisResult) => void = () => {};
		const started = new Promise<AnalysisHandle | null>((resolve) => {
			start = resolve;
		});
		const result = new Promise<AnalysisResult>((resolve) => {
			settle = resolve;
		});
		async function* updates(): AsyncGenerator<AnalysisUpdate> {
			const inner = await started;
			if (inner) yield* inner.updates;
		}
		const job: RoutedAnalysis = {
			req,
			inner: null,
			cancelled: false,
			superseded: false,
			start,
			settle,
			handle: { id: req.id, updates: updates(), result, stop: () => this.stopRouted(job) },
		};
		this.track(job.handle, false);
		if (this.disposed) {
			void this.stopRouted(job);
			return job.handle;
		}
		const index = this.routedQueue.findIndex((queued) => priority(queued.req) > priority(req));
		if (index < 0) this.routedQueue.push(job);
		else this.routedQueue.splice(index, 0, job);
		const active = this.routedActive;
		if (
			active &&
			(active.req.priority === "ponder" ||
				priority(req) < priority(active.req) ||
				(active.inner && priority(req) === priority(active.req)))
		) {
			active.superseded = true;
			void this.stopRouted(active).catch(() => {});
		}
		this.pumpRouted();
		return job.handle;
	}

	private async stopRouted(job: RoutedAnalysis): Promise<void> {
		job.cancelled = true;
		if (job.inner) {
			await job.inner.stop();
			return;
		}
		job.start(null);
		job.settle(emptyResult(job.req, "superseded"));
		const index = this.routedQueue.indexOf(job);
		if (index >= 0) this.routedQueue.splice(index, 1);
		if (this.routedActive === job) this.routedActive = null;
		this.pumpRouted();
	}

	private pumpRouted(): void {
		// A reset must await initialization, but it need not keep downloading the previous
		// session's network once the next session has supplied its active target.
		if (this.gameChange && this.variantChange && !this.routedActive) {
			const next = this.routedQueue[0];
			if (next) {
				this.routeRequest = next.req;
				if (this.loadingVariant !== this.desiredVariant()) this.variantAbort?.abort();
			}
		}
		if (this.disposed || this.suspendApply || this.gameChange || this.routedActive) return;
		const job = this.routedQueue.shift();
		if (!job) return;
		this.routedActive = job;
		this.routeRequest = job.req;
		if (this.variantChange && this.loadingVariant !== this.desiredVariant())
			this.variantAbort?.abort();
		void this.runRouted(job);
	}

	private async runRouted(job: RoutedAnalysis): Promise<void> {
		try {
			if (!this.settings) await this.ready;
			while (true) {
				if (job.cancelled || this.disposed) return;
				if (this.needsVariantChange()) this.startVariantChange();
				if (this.variantChange) {
					await this.variantChange;
					continue;
				}
				if (this.pending) await this.applyOptions();
				if (job.cancelled || this.disposed) return;
				// Settings may have changed during the option acknowledgement.
				if (!this.needsVariantChange() && !this.variantChange) break;
			}
			this.refreshNetworkCache();
			const hit = this.lookup(job.req);
			const generation = this.cacheGeneration;
			job.inner = hit ? cachedHandle(job.req, hit) : this.engine.analyse(job.req);
			job.start(job.inner);
			const result = await job.inner.result;
			const outcome = job.superseded ? { ...result, status: "superseded" as const } : result;
			this.refreshNetworkCache();
			if (!hit && generation === this.cacheGeneration) this.store(outcome);
			job.settle(outcome);
		} catch {
			job.start(null);
			job.settle(emptyResult(job.req, job.cancelled ? "superseded" : "failed"));
		} finally {
			if (this.routedActive === job) {
				this.routedActive = null;
				this.pumpRouted();
			}
		}
	}

	private refreshNetworkCache(): void {
		const loaded = this.getLoadedVariant?.();
		if (loaded === undefined || loaded === this.lastLoadedVariant) return;
		this.lastLoadedVariant = loaded;
		this.cacheGeneration++;
		this.cache?.clear();
	}

	/** Without a network configurator, UCI owns admission after a game reset. */
	private afterVariantChange(req: AnalysisRequest, change: Promise<void>): AnalysisHandle {
		let cancelled = false;
		let inner: AnalysisHandle | null = null;
		let settle: (result: AnalysisResult) => void = () => {};
		const result = new Promise<AnalysisResult>((resolve) => {
			settle = resolve;
		});
		const started = change.then(
			() => {
				if (cancelled || this.disposed) return null;
				inner = this.engine.analyse(req);
				return inner;
			},
			() => null
		);
		void started
			.then(async (handle) => {
				settle(handle ? await handle.result : emptyResult(req, cancelled ? "superseded" : "failed"));
			})
			.catch(() => settle(emptyResult(req, "failed")));
		async function* updates(): AsyncGenerator<AnalysisUpdate> {
			const handle = await started;
			if (handle) yield* handle.updates;
		}
		const handle: AnalysisHandle = {
			id: req.id,
			updates: updates(),
			result,
			stop: async () => {
				cancelled = true;
				if (inner) await inner.stop();
				else settle(emptyResult(req, "superseded"));
			},
		};
		this.track(handle);
		return handle;
	}

	/**
	 * Send the diff between the wanted and the applied options when the engine
	 * is idle; otherwise leave it pending for the next settlement / `newGame` /
	 * `init`. Re-entrancy safe: a change during the `isready` round trip is
	 * picked up by the loop.
	 */
	private async applyOptions(): Promise<void> {
		if (this.applying || this.variantChange) return;
		this.applying = true;
		try {
			while (this.pending && !this.disposed && !this.suspendApply) {
				const wanted = this.wanted;
				if (!wanted) return;
				if (this.engine.state() !== "idle") {
					log.debug("engine-controller: options deferred while", this.engine.state());
					return;
				}
				this.pending = false;
				const diff = diffOptions(wanted, this.applied);
				if (Object.keys(diff).length === 0) {
					this.applied = wanted;
					continue;
				}
				try {
					await this.engine.setOptions(diff);
					this.applied = wanted;
					this.appliedAt = this.now();
					log.debug("engine-controller: options applied", diff);
				} catch (err) {
					// Not initialised or no longer idle: keep the change for the next idle moment.
					this.pending = true;
					log.debug("engine-controller: options not applied", String(err));
					return;
				}
			}
		} finally {
			this.applying = false;
		}
	}

	private track(handle: AnalysisHandle, store = true): void {
		this.inFlight.add(handle);
		const generation = this.cacheGeneration;
		void handle.result.then((result) => {
			this.inFlight.delete(handle);
			if (store && generation === this.cacheGeneration) this.store(result);
			if (this.pending) void this.applyOptions();
		});
	}

	/**
	 * Appendix E §4.5: "a hit with depth ≥ requested depthCap − 2 skips the search". The slack is
	 * the point — an own-move request carries `depth: depthCap` as a *stop* condition on a
	 * `movetime` search, so a cached result is essentially never exactly that deep and requiring it
	 * made the cache unreachable for the one path it exists for (a position already analysed during
	 * the opponent's turn). Low explicit ceilings remain valid below feature depth `D_f`.
	 */
	private minDepthFor(req: AnalysisRequest): number {
		const depth = req.limit.depth;
		if (depth === undefined)
			return req.limit.infinite
				? automaticDepthForElo(req.targetElo ?? req.elo ?? LIMITS.eloMax)
				: this.cacheMinDepth;
		return Math.min(depth, Math.max(this.cacheMinDepth, depth - SEARCH_BUDGET.cacheDepthSlack));
	}

	private lookup(req: AnalysisRequest): AnalysisResult | undefined {
		if (!this.cache) return undefined;
		// A restricted search is answered from the cache only when it is a Maia-shaped own-move
		// search (H10): its root set is part of the identity, and the pre-analysis of the predicted
		// position asks for exactly the same set. The extra referee search is never answered.
		if (req.searchmoves?.length && req.shaped !== true) return undefined;
		// The human frame is part of the identity (H4): a hit must carry the frame this request asks
		// for, which is why the Maia-mode pre-analysis has to ask for the same `featureDepth`.
		return this.cache.get(
			req.fen,
			req.multiPv,
			this.minDepthFor(req),
			req.elo,
			req.moves,
			req.limit.depth,
			req.featureDepth,
			req.searchmoves
		);
	}

	/** Keep the search history: the same board can have a different repetition outcome. */
	private store(result: AnalysisResult): void {
		this.cache?.set(result);
	}
}
