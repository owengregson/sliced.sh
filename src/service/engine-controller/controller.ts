/** Owns engine options, network routing, and priority-aware cached analysis. */

import { LIMITS } from "@core/constants/limits";
import { TIMINGS } from "@core/constants/timings";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import {
	type EngineOptions,
	type OptionsEnv,
	optionsForSettings,
	requestEloForTarget,
	variantForSettings,
} from "@core/engine/options";
import type { AnalysisHandle, AnalysisRequest, EngineInfo } from "@core/engine/types";
import { FEATURE_DEPTH, type UciEngine } from "@core/engine/uci-client";
import { log } from "@core/logger";
import { isMaxStrength } from "@core/strength/max-strength";
import { newId } from "@core/util/ids";
import { cachedHandle, emptyResult } from "@service/analysis/handles";
import { ControllerCache } from "@service/engine-controller/cache-policy";
import { analysisAfter } from "@service/engine-controller/deferred-analysis";
import { diffOptions } from "@service/engine-controller/options-diff";
import {
	enqueueByPriority,
	type RoutedAnalysis,
	routedJob,
	supersedes,
} from "@service/engine-controller/routed-queue";
import type {
	EngineControllerDeps,
	EngineControllerStatus,
} from "@service/engine-controller/types";
import type { EngineVariant } from "@typedefs/engine";
import type { Settings } from "@typedefs/settings";

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
	private readonly cache: ControllerCache;
	private readonly env: OptionsEnv;
	private readonly now: () => number;
	private readonly unsubscribe: () => void;
	private readonly configureVariant: EngineControllerDeps["configureVariant"];
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
	/**
	 * The last active target a request carried (max-strength mode, owner 2026-09-15): the engine's own
	 * options follow it (`optionsForSettings`), since the session's target — not the stored slider —
	 * is what plays. Absent until a request carries one.
	 */
	private optionsTarget: number | undefined;

	constructor(
		private readonly engine: UciEngine,
		deps: EngineControllerDeps
	) {
		this.cache = new ControllerCache(
			deps.cache,
			deps.cacheMinDepth ?? FEATURE_DEPTH,
			deps.getLoadedVariant
		);
		this.env = deps.env;
		this.now = deps.now ?? (() => Date.now());
		this.configureVariant = deps.configureVariant;
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
		if (this.gameChange) {
			const handle = analysisAfter(req, this.gameChange, () =>
				this.disposed ? null : this.engine.analyse(req)
			);
			this.track(handle);
			return handle;
		}
		this.followTarget(req);
		const hit = this.cache.lookup(req);
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
			cacheSize: this.cache.size,
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

	// ── settings → options ───────────────────────────────────────────────

	private onSettings(settings: Settings): void {
		if (this.disposed) return;
		this.settings = settings;
		this.wanted = optionsForSettings(settings, this.env, this.optionsTarget);
		this.pending = true;
		if (this.needsVariantChange() || this.variantChange) {
			if (this.loadingVariant !== this.desiredVariant()) this.variantAbort?.abort();
			this.startVariantChange();
			return;
		}
		void this.applyOptions();
	}

	/**
	 * Max-strength mode (owner, 2026-09-15: "maximal performance"): record `req`'s active target, and
	 * when it crosses the mode boundary re-derive the options (`optionsForSettings`) for the next idle
	 * moment — on the routed path, before this request's own search. Below the ceiling the options do
	 * not depend on the target, so no other request adds an option round trip or resizes the hash.
	 */
	private followTarget(req: AnalysisRequest): void {
		const target = req.targetElo;
		const settings = this.settings;
		if (target === undefined || !Number.isFinite(target) || !settings || this.disposed) return;
		const wasMax = this.optionsTarget !== undefined && isMaxStrength(this.optionsTarget);
		this.optionsTarget = target;
		if (isMaxStrength(target) === wasMax) return;
		this.wanted = optionsForSettings(settings, this.env, target);
		this.pending = true;
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

	// ── network variant ─────────────────────────────────────────────────

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
				this.cache.invalidate();
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

	// ── routed admission ────────────────────────────────────────────────

	private enqueueRouted(req: AnalysisRequest): AnalysisHandle {
		const job = routedJob(req, (j) => this.stopRouted(j));
		this.track(job.handle, false);
		if (this.disposed) {
			void this.stopRouted(job);
			return job.handle;
		}
		enqueueByPriority(this.routedQueue, job);
		const active = this.routedActive;
		if (active && supersedes(active, req)) {
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
		this.followTarget(job.req);
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
			this.cache.refreshNetwork();
			const hit = this.cache.lookup(job.req);
			const generation = this.cache.generation;
			job.inner = hit ? cachedHandle(job.req, hit) : this.engine.analyse(job.req);
			job.start(job.inner);
			const result = await job.inner.result;
			const outcome = job.superseded ? { ...result, status: "superseded" as const } : result;
			this.cache.refreshNetwork();
			if (!hit && generation === this.cache.generation) this.cache.store(outcome);
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

	private track(handle: AnalysisHandle, store = true): void {
		this.inFlight.add(handle);
		const generation = this.cache.generation;
		void handle.result.then((result) => {
			this.inFlight.delete(handle);
			if (store && generation === this.cache.generation) this.cache.store(result);
			if (this.pending) void this.applyOptions();
		});
	}
}
