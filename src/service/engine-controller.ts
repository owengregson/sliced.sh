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

import { applyMoves } from "@core/chess/san";
import type { AnalysisCache } from "@core/engine/analysis-cache";
import { type EngineOptions, type OptionsEnv, optionsForSettings } from "@core/engine/options";
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

	constructor(
		private readonly engine: UciEngine,
		deps: EngineControllerDeps
	) {
		this.cache = deps.cache;
		this.env = deps.env;
		this.now = deps.now ?? (() => Date.now());
		this.cacheMinDepth = deps.cacheMinDepth ?? FEATURE_DEPTH;
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
		const info = await this.engine.init();
		await this.ready;
		await this.applyOptions();
		return info;
	}

	/** Cache hit → a settled handle; otherwise queued on the engine at `req.priority`. */
	analyse(req: AnalysisRequest): AnalysisHandle {
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
	async newGame(gameId?: string): Promise<void> {
		if (gameId !== undefined && gameId === this.gameId) return;
		this.gameId = gameId ?? null;
		this.suspendApply = true;
		try {
			await Promise.all([...this.inFlight].map((h) => h.stop()));
			await this.engine.newGame();
		} finally {
			this.suspendApply = false;
		}
		await this.applyOptions();
	}

	/** `UCI_Elo` the engine runs with (from the applied options, else the wanted ones). */
	engineElo(): number | undefined {
		return (this.applied ?? this.wanted)?.UCI_Elo;
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
		this.unsubscribe();
		this.inFlight.clear();
	}

	private onSettings(settings: Settings): void {
		if (this.disposed) return;
		this.settings = settings;
		this.wanted = optionsForSettings(settings, this.env);
		this.pending = true;
		void this.applyOptions();
	}

	/**
	 * Send the diff between the wanted and the applied options when the engine
	 * is idle; otherwise leave it pending for the next settlement / `newGame` /
	 * `init`. Re-entrancy safe: a change during the `isready` round trip is
	 * picked up by the loop.
	 */
	private async applyOptions(): Promise<void> {
		if (this.applying) return;
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

	/** Position a request analyses (`fen` after `moves`); `null` when a move is illegal. */
	private static effectiveFen(req: AnalysisRequest): string | null {
		return req.moves && req.moves.length > 0 ? applyMoves(req.fen, req.moves) : req.fen;
	}

	private minDepthFor(req: AnalysisRequest): number {
		if (req.limit.infinite) return this.settings?.engine.depthCap ?? this.cacheMinDepth;
		return req.limit.depth ?? this.cacheMinDepth;
	}

	private lookup(req: AnalysisRequest): AnalysisResult | undefined {
		if (!this.cache) return undefined;
		const fen = EngineController.effectiveFen(req);
		if (fen === null) return undefined;
		return this.cache.get(fen, req.multiPv, this.minDepthFor(req), req.elo);
	}

	/** Cache under the position reached (the cache keys on `request.fen` alone). */
	private store(result: AnalysisResult): void {
		if (!this.cache) return;
		const { request } = result;
		if (!request.moves || request.moves.length === 0) {
			this.cache.set(result);
			return;
		}
		const fen = applyMoves(request.fen, request.moves);
		if (fen === null) return;
		const { moves: _moves, ...rest } = request;
		this.cache.set({ ...result, request: { ...rest, fen } });
	}
}
