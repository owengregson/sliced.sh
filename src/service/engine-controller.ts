/**
 * Engine controller (Task 13): the service worker's owner of the engine's
 * option state. Turns `Settings` into `EngineOptions` (`optionsForSettings`)
 * on construction and on every settings change, sends only the diff (the
 * client diffs again against what the engine actually has), and defers a
 * change that arrives while the engine is searching until it is idle again.
 * `analyse` / `ponder` put the `AnalysisCache` in front of the engine and pass
 * the request priority (`move` > `ponder` > `panel`) straight through.
 *
 * Wiring into `bootstrapServiceSystems()` (Task 9) is deferred to Task 30 by
 * controller ruling: nothing here is instantiated yet.
 */

import { SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisCache } from "@core/engine/analysis-cache";
import {
	type EngineOptions,
	type OptionsEnv,
	optionsForSettings,
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
	 * (default `FEATURE_DEPTH`, the timing model's `D_f`). Infinite requests need
	 * `settings.engine.depthCap`; `limit.depth` requests need that depth.
	 */
	cacheMinDepth?: number;
	/** Resolves only when the requested variant and its verified networks are loaded. */
	configureVariant?: (variant: EngineVariant, threads: number, signal: AbortSignal) => Promise<void>;
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
	private configuredVariant: EngineVariant | null = null;
	private loadingVariant: EngineVariant | null = null;
	private variantChange: Promise<void> | null = null;
	private variantAbort: AbortController | null = null;
	private configuredInfo: EngineInfo | null = null;
	private gameChange: Promise<void> | null = null;
	private resettingGameId: string | undefined;

	constructor(
		private readonly engine: UciEngine,
		deps: EngineControllerDeps
	) {
		this.cache = deps.cache;
		this.env = deps.env;
		this.now = deps.now ?? (() => Date.now());
		this.cacheMinDepth = deps.cacheMinDepth ?? FEATURE_DEPTH;
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
		if (this.needsVariantChange()) this.startVariantChange();
		if (this.gameChange) {
			const ready = Promise.all([this.gameChange, this.variantChange]).then(() => {});
			return this.afterVariantChange(req, ready);
		}
		if (this.variantChange) return this.afterVariantChange(req, this.variantChange);
		const hit = this.lookup(req);
		if (hit) {
			log.debug("engine-controller: cache hit", req.id, req.priority ?? "move");
			return cachedHandle(req, hit);
		}
		const handle = this.engine.analyse(req);
		this.track(handle);
		return handle;
	}

	/** `go infinite` at the current strength as a `ponder` request (cached like any other). */
	ponder(fen: string, moves: string[], multiPv: number): AnalysisHandle {
		return this.analyse({
			id: newId(),
			fen,
			moves,
			multiPv,
			limit: { infinite: true },
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
		this.inFlight.clear();
	}

	private onSettings(settings: Settings): void {
		if (this.disposed) return;
		this.settings = settings;
		this.wanted = optionsForSettings(settings, this.env);
		this.pending = true;
		if (this.needsVariantChange() || this.variantChange) {
			if (this.loadingVariant !== variantForSettings(settings)) this.variantAbort?.abort();
			this.startVariantChange();
			return;
		}
		void this.applyOptions();
	}

	private needsVariantChange(): boolean {
		return (
			!this.disposed &&
			this.configureVariant !== undefined &&
			this.settings !== undefined &&
			variantForSettings(this.settings) !== this.configuredVariant
		);
	}

	private startVariantChange(): void {
		if (this.variantChange || !this.configureVariant) return;
		const configure = this.configureVariant;
		const run = async (): Promise<void> => {
			while (this.settings && this.wanted && !this.disposed) {
				const variant = variantForSettings(this.settings);
				const wanted = this.wanted;
				const ac = new AbortController();
				this.variantAbort = ac;
				this.loadingVariant = variant;
				await Promise.all([...this.inFlight].map((handle) => handle.stop()));
				if (ac.signal.aborted) continue;
				this.cache?.clear();
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
				if (this.wanted === wanted) {
					this.pending = false;
					return;
				}
			}
		};
		const operation = run();
		this.variantChange = operation;
		void operation
			.then(
				() => {},
				(error: unknown) => {
					log.warn("engine-controller: network configuration failed", String(error));
				}
			)
			.finally(() => {
				if (this.variantChange === operation) this.variantChange = null;
				this.variantAbort = null;
				this.loadingVariant = null;
			});
	}

	/** Searches wait through downloads and game resets without using stale cache or options. */
	private afterVariantChange(req: AnalysisRequest, change: Promise<void>): AnalysisHandle {
		let cancelled = false;
		let inner: AnalysisHandle | null = null;
		let settle: (result: AnalysisResult) => void = () => {};
		const result = new Promise<AnalysisResult>((resolve) => {
			settle = resolve;
		});
		const failed = (status: AnalysisResult["status"]): AnalysisResult => ({
			id: req.id,
			bestmove: null,
			request: req,
			status,
			final: { id: req.id, depth: 0, lines: [], nodes: 0, nps: 0, timeMs: 0, complete: false },
		});
		const started = change.then(
			() => {
				if (cancelled || this.disposed) return null;
				const corrected = { ...req };
				const elo = this.engineElo();
				if (elo === undefined) delete corrected.elo;
				else corrected.elo = elo;
				inner = this.engine.analyse(corrected);
				return inner;
			},
			() => null
		);
		void started
			.then(async (handle) => {
				settle(handle ? await handle.result : failed(cancelled ? "superseded" : "failed"));
			})
			.catch(() => settle(failed("failed")));
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
				else settle(failed("superseded"));
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

	private track(handle: AnalysisHandle): void {
		this.inFlight.add(handle);
		void handle.result.then((result) => {
			this.inFlight.delete(handle);
			this.store(result);
			if (this.pending) void this.applyOptions();
		});
	}

	/**
	 * Appendix E §4.5: "a hit with depth ≥ requested depthCap − 2 skips the search". The slack is
	 * the point — an own-move request carries `depth: depthCap` as a *stop* condition on a
	 * `movetime` search, so a cached result is essentially never exactly that deep and requiring it
	 * made the cache unreachable for the one path it exists for (a position already analysed during
	 * the opponent's turn). Never below `cacheMinDepth`: the timing features need `D_f`.
	 */
	private minDepthFor(req: AnalysisRequest): number {
		if (req.limit.infinite) return this.settings?.engine.depthCap ?? this.cacheMinDepth;
		const depth = req.limit.depth;
		if (depth === undefined) return this.cacheMinDepth;
		return Math.max(this.cacheMinDepth, depth - SEARCH_BUDGET.cacheDepthSlack);
	}

	private lookup(req: AnalysisRequest): AnalysisResult | undefined {
		if (!this.cache || req.searchmoves?.length) return undefined;
		return this.cache.get(req.fen, req.multiPv, this.minDepthFor(req), req.elo, req.moves);
	}

	/** Keep the search history: the same board can have a different repetition outcome. */
	private store(result: AnalysisResult): void {
		this.cache?.set(result);
	}
}
