/**
 * Offscreen engine host (§6.3 `engine-host.ts`, §6.4 backpressure).
 *
 * `EngineHost` owns exactly one Stockfish instance and speaks the engine port
 * protocol (`EnginePortCommand` in, `EnginePortMessage` out):
 *   - `configure` boots the engine (first command) or reboots it for a new
 *     variant; `uci` lines go to `sf.uci` (queued while booting); `loadNnue`
 *     sets the named nets in order; `restart` quits and re-boots at once.
 *   - engine output: `info` lines are coalesced per multipv index and
 *     forwarded at most every `TIMINGS.engineInfoForwardMs` (`currmove`
 *     progress lines are dropped, `info string` passes straight through);
 *     every other line flushes the pending infos first so order is kept.
 *   - `sf.onError` (stderr) is a crash: status `crashed` carrying the message,
 *     then a reboot after `TIMINGS.engineRestartBackoffMs[attempt]`; once the
 *     steps are exhausted the host stays `crashed`. A completed search
 *     (`bestmove`) or an explicit restart resets the attempt counter.
 *   - status: `booting → loading-nnue → ready`, `searching` on `go`, `ready`
 *     on `bestmove`; `EngineStatus.version` starts as the loaded module name
 *     and becomes the engine's `id name` once seen; `nps` follows the last
 *     `info` line.
 *
 * `serveEnginePort` is the port side: the service worker initiates
 * (`RemoteEngine` → `runtime.connect`), the document *accepts* — §6.3's
 * "connects / re-connects" prose is implemented as "accept the SW's connection
 * and re-send the current status on each new one", which is how the engine
 * state survives a service-worker restart. Only the newest accepted port is
 * routed; its disconnect aborts pending NNUE downloads. The first `configure`
 * carrying `warmTiming` pre-warms the timing head's default band (Task 34);
 * without it nothing is loaded, so a v1 user pays nothing. Likewise `warmPolicy`
 * pre-loads that Maia-3 size (2026-09-11), and `policy` / `policy-warm` route to
 * the policy host; a served document without one answers `not-available`.
 */

import { DEFAULT_ENGINE_STATUS } from "@core/constants/defaults";
import type { MaiaSize } from "@core/constants/maia";
import type {
	EnginePortCommand,
	EnginePortMessage,
	ModelChunk,
	NnueChunk,
} from "@core/constants/messages";
import { CHESSMIMIC_DEFAULT_BAND } from "@core/constants/models";
import { PORT_NAMES } from "@core/constants/ports";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import { DEFAULT_SCHEDULER, type TimerScheduler } from "@core/util/scheduler";
import type StockfishWeb from "@lichess-org/stockfish-web";
import type { EngineStatus, EngineVariant } from "@typedefs/engine";
import { POLICY_NOT_AVAILABLE, type PolicyInference } from "./policy-inference";
import { errorMessage } from "./shared/errors";
import type { BootedEngine, NnueSource } from "./stockfish-loader";
import { TIMING_NOT_AVAILABLE, type TimingInference } from "./timing-inference";

export type HostScheduler = TimerScheduler;

/** The store surface the host uses: `get` for `loadNnue`, `delete` to evict a net the engine rejected. */
export interface HostNnueStore extends NnueSource {
	delete?(name: string): Promise<void>;
}

/** What the loader needs from the host for one engine instance. */
export interface BootHooks {
	listen(line: string): void;
	onError(msg: string): void;
	onLoadingNnue(names: string[]): void;
}

export interface EngineHostDeps {
	/** Reviews must fail visibly rather than substitute a weaker network. */
	allowSmallnetFallback?: boolean;
	boot(variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine>;
	nnueStore: HostNnueStore;
	post(msg: EnginePortMessage): void;
	scheduler?: HostScheduler;
}

const MULTIPV_RE = /\bmultipv (\d+)/;
const NPS_RE = /\bnps (\d+)/;
const THREADS_OPTION_RE = /^setoption name Threads value (\d+)\s*$/;
const ID_NAME_PREFIX = "id name ";
/** stderr prefix the engine wrapper uses for a rejected network: evict the cached copy. */
const BAD_NNUE_PREFIX = "BAD_NNUE";
const NOOP = (): void => {};

export class EngineHost {
	private readonly sched: HostScheduler;
	private readonly st: EngineStatus = { ...DEFAULT_ENGINE_STATUS, nnue: [] };
	private sf: StockfishWeb | undefined;
	private started = false;
	private booting = false;
	/** Bumped on every boot/teardown so callbacks from a superseded instance are ignored. */
	private seq = 0;
	private queued: string[] = [];
	private pendingNnue: string[] | undefined;
	private attempt = 0;
	/**
	 * The variant the service worker asked for while the host runs the small-net build in its
	 * place: the full build crashed twice in a row (2026-09-12, pthread worker faults on the
	 * owner's machine), and a game with no engine is worse than a game on the small net. An
	 * explicit `restart` (the panel's button) tries the requested build again.
	 */
	private fallbackFrom: EngineVariant | undefined;
	private rebootTimer: unknown;
	private readonly pendingInfo = new Map<number, string>();
	private flushTimer: unknown;
	private lastFlushAt = Number.NEGATIVE_INFINITY;
	private disposed = false;

	constructor(private readonly deps: EngineHostDeps) {
		this.sched = deps.scheduler ?? DEFAULT_SCHEDULER;
	}

	status(): EngineStatus {
		return { ...this.st, nnue: [...this.st.nnue] };
	}

	handle(cmd: EnginePortCommand): void {
		if (this.disposed) return;
		switch (cmd.kind) {
			case "configure":
				this.configure(cmd.variant, cmd.threads);
				return;
			case "uci":
				this.uci(cmd.line);
				return;
			case "restart":
				this.restartRequested();
				return;
			case "loadNnue":
				this.loadNnue(cmd.names);
				return;
			default:
				log.debug("engine-host: command not handled here", { kind: cmd.kind });
		}
	}

	/** Quit the engine, cancel timers; the host is inert afterwards. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelReboot();
		this.clearFlush();
		this.pendingInfo.clear();
		this.teardownEngine();
	}

	// ── commands ─────────────────────────────────────────────────────────

	private configure(variant: EngineVariant, threads: number): void {
		const threadsChanged = this.st.threads !== threads;
		this.st.threads = threads;
		if (!this.started) {
			this.started = true;
			this.st.variant = variant;
			this.startBoot();
			return;
		}
		if (this.fallbackFrom !== undefined && variant === this.st.variant) {
			// The SW now asks for the build the host fell back *to*: the fallback is simply the
			// configuration, nothing to remember any more.
			this.clearFallback();
		}
		// A request for the build that crashed is answered by the fallback already running.
		const effective = variant === this.fallbackFrom ? this.st.variant : variant;
		if (effective !== this.st.variant) {
			this.clearFallback();
			this.st.variant = effective;
			this.restart();
			return;
		}
		if (this.gaveUp()) {
			this.restart();
			return;
		}
		// Also acknowledges an idempotent configure after a service-worker reconnect.
		if (threadsChanged || this.st.state !== "searching") this.postStatus();
	}

	private uci(line: string): void {
		if (!this.started) this.configure(this.st.variant, this.st.threads);
		else if (this.gaveUp()) this.restart(); // the SW re-initialising after a give-up
		if (!this.sf || this.booting) {
			this.queued.push(line);
			return;
		}
		this.sendLine(this.sf, line);
	}

	private sendLine(sf: StockfishWeb, line: string): void {
		const threads = THREADS_OPTION_RE.exec(line);
		if (threads) this.st.threads = Number(threads[1]);
		try {
			sf.uci(line);
		} catch (error) {
			this.onCrash(`uci failed: ${errorMessage(error)}`);
			return;
		}
		if (line.startsWith("go") && this.st.state !== "searching") this.setState("searching");
	}

	/** Crashed with the backoff steps exhausted: no engine, no boot, no reboot pending. */
	private gaveUp(): boolean {
		return !this.sf && !this.booting && this.rebootTimer === undefined;
	}

	private restart(): void {
		this.cancelReboot();
		this.attempt = 0;
		this.teardownEngine();
		this.startBoot();
	}

	/** The panel's Restart: also the one way back from the small-net fallback to the requested build. */
	private restartRequested(): void {
		if (this.fallbackFrom !== undefined) {
			log.info("engine-host: restart requested; trying the requested build again", {
				variant: this.fallbackFrom,
			});
			this.st.variant = this.fallbackFrom;
			this.clearFallback();
		}
		this.restart();
	}

	private clearFallback(): void {
		this.fallbackFrom = undefined;
		delete this.st.fallbackFrom;
	}

	/**
	 * A second consecutive crash of the full build: reboot as the small-net build instead of
	 * burning the remaining backoff steps on the same fault. The status carries `fallbackFrom` so
	 * the service worker's configuration wait accepts the substitute and the panel can say so.
	 */
	private fallBackIfRepeated(): boolean {
		if (this.deps.allowSmallnetFallback === false) return false;
		if (this.st.variant !== "full" || this.fallbackFrom !== undefined || this.attempt < 1)
			return false;
		log.warn("engine-host: the full build crashed again; running the small-net build instead", {
			attempt: this.attempt,
		});
		this.fallbackFrom = "full";
		this.st.fallbackFrom = "full";
		this.st.variant = "smallnet";
		this.st.nnue = [];
		this.attempt = 0;
		return true;
	}

	private loadNnue(names: string[]): void {
		if (!this.sf || this.booting) {
			this.pendingNnue = names;
			return;
		}
		void this.applyNnue(this.sf, this.seq, names);
	}

	private async applyNnue(sf: StockfishWeb, seq: number, names: string[]): Promise<void> {
		this.setState("loading-nnue");
		try {
			for (let i = 0; i < names.length; i++) {
				const name = names[i] as string;
				const buf = await this.deps.nnueStore.get(name);
				if (seq !== this.seq) return;
				sf.setNnueBuffer(buf, i);
			}
			this.st.nnue = [...names];
			this.setState("ready");
		} catch (error) {
			if (seq !== this.seq) return;
			log.warn("engine-host: loadNnue failed", { names, error: errorMessage(error) });
			this.setState("ready", errorMessage(error));
		}
	}

	// ── lifecycle ────────────────────────────────────────────────────────

	private startBoot(): void {
		const seq = ++this.seq;
		this.booting = true;
		this.clearFlush();
		this.pendingInfo.clear();
		this.setState("booting");
		const guard = <A extends unknown[]>(fn: (...args: A) => void) => {
			return (...args: A): void => {
				if (seq === this.seq && !this.disposed) fn(...args);
			};
		};
		const hooks: BootHooks = {
			listen: guard((line: string) => this.onLine(line)),
			onError: guard((msg: string) => this.onCrash(msg)),
			onLoadingNnue: guard((names: string[]) => {
				this.st.nnue = [...names];
				this.setState("loading-nnue");
			}),
		};
		this.deps.boot(this.st.variant, hooks).then(
			(booted) => {
				if (seq !== this.seq || this.disposed) {
					quit(booted.sf);
					return;
				}
				this.sf = booted.sf;
				this.booting = false;
				this.st.version = booted.module;
				this.st.nnue = [...booted.nnue];
				this.setState("ready");
				const lines = this.queued;
				this.queued = [];
				for (const line of lines) {
					if (this.sf !== booted.sf) break;
					this.sendLine(booted.sf, line);
				}
				const pending = this.pendingNnue;
				this.pendingNnue = undefined;
				if (pending && this.sf === booted.sf) void this.applyNnue(booted.sf, seq, pending);
			},
			(error: unknown) => {
				if (seq !== this.seq || this.disposed) return;
				this.booting = false;
				this.onCrash(errorMessage(error));
			}
		);
	}

	private teardownEngine(): void {
		this.seq++;
		const sf = this.sf;
		this.sf = undefined;
		this.booting = false;
		if (sf) quit(sf);
	}

	private onCrash(message: string): void {
		if (this.disposed) return;
		log.error("engine-host: engine crashed", { message, attempt: this.attempt });
		this.cancelReboot(); // a second entry must not burn another backoff step
		this.teardownEngine();
		this.clearFlush();
		this.pendingInfo.clear();
		if (message.startsWith(BAD_NNUE_PREFIX)) this.evictNets();
		this.fallBackIfRepeated();
		this.setState("crashed", message);
		const steps = TIMINGS.engineRestartBackoffMs;
		if (this.attempt >= steps.length) {
			log.error("engine-host: giving up after the last backoff step", { message });
			return;
		}
		const wait = steps[this.attempt] as number;
		this.attempt++;
		this.rebootTimer = this.sched.setTimeout(() => {
			this.rebootTimer = undefined;
			this.startBoot();
		}, wait);
	}

	/** The engine rejected a net: drop the cached copies so the reboot downloads fresh ones. */
	private evictNets(): void {
		const remove = this.deps.nnueStore.delete;
		if (!remove) return;
		for (const name of this.st.nnue) {
			remove.call(this.deps.nnueStore, name).catch((error: unknown) => {
				log.warn("engine-host: could not evict net", { name, error: errorMessage(error) });
			});
		}
	}

	private cancelReboot(): void {
		if (this.rebootTimer === undefined) return;
		this.sched.clearTimeout(this.rebootTimer);
		this.rebootTimer = undefined;
	}

	// ── output ───────────────────────────────────────────────────────────

	private onLine(line: string): void {
		if (line.startsWith("info")) {
			if (line.startsWith("info string")) {
				this.flushInfo();
				this.deps.post({ kind: "line", line });
				return;
			}
			if (line.includes(" currmove ")) return; // progress noise (§6.4)
			const nps = NPS_RE.exec(line);
			if (nps) this.st.nps = Number(nps[1]);
			const multipv = MULTIPV_RE.exec(line);
			this.pendingInfo.set(multipv ? Number(multipv[1]) : 1, line);
			this.scheduleFlush();
			return;
		}
		this.flushInfo();
		if (line.startsWith(ID_NAME_PREFIX)) {
			this.st.version = line.slice(ID_NAME_PREFIX.length).trim();
			// Publish the identity during the handshake, before `uciok` can finish warming.
			// Otherwise the remote reviewer captures the boot module's filename, sees this
			// name only on the first `go` status, and rejects every search as a network change.
			this.postStatus();
		}
		this.deps.post({ kind: "line", line });
		if (line.startsWith("bestmove")) {
			this.attempt = 0;
			if (this.st.state === "searching") this.setState("ready");
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) return;
		const elapsed = this.sched.now() - this.lastFlushAt;
		const wait = Math.max(0, TIMINGS.engineInfoForwardMs - elapsed);
		this.flushTimer = this.sched.setTimeout(() => {
			this.flushTimer = undefined;
			this.flushInfo();
		}, wait);
	}

	private flushInfo(): void {
		this.clearFlush();
		if (this.pendingInfo.size === 0) return;
		this.lastFlushAt = this.sched.now();
		const keys = [...this.pendingInfo.keys()].sort((a, b) => a - b);
		for (const k of keys) this.deps.post({ kind: "line", line: this.pendingInfo.get(k) as string });
		this.pendingInfo.clear();
	}

	private clearFlush(): void {
		if (this.flushTimer === undefined) return;
		this.sched.clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}

	// ── status ───────────────────────────────────────────────────────────

	private setState(state: EngineStatus["state"], error?: string): void {
		this.st.state = state;
		if (error !== undefined) this.st.error = error;
		else delete this.st.error;
		this.postStatus();
	}

	private postStatus(): void {
		this.deps.post({ kind: "status", status: this.status() });
	}
}

/** Detach and ask the instance to exit (the pthread worker terminates on `quit`). */
function quit(sf: StockfishWeb): void {
	sf.listen = NOOP;
	sf.onError = NOOP;
	try {
		sf.uci("quit");
	} catch {
		// already gone
	}
}

// ── port side ────────────────────────────────────────────────────────────

/** The store operations the port router needs. */
export interface NnueStoreLike {
	handleChunk(msg: NnueChunk): void;
	abortAll(reason: string): void;
}

/** The ChessMimic band store as the router sees it (Task 34). */
export interface ModelStoreLike {
	handleChunk(msg: ModelChunk): void;
	abortAll(reason: string): void;
}

export interface ServeEngineDeps<
	S extends NnueStoreLike,
	M extends ModelStoreLike = ModelStoreLike,
> {
	portName?: typeof PORT_NAMES.engine | typeof PORT_NAMES.reviewEngine;
	/** Release background engine memory when its service-worker owner disconnects. */
	disposeOnDisconnect?: boolean;
	createStore(post: (msg: EnginePortMessage) => void): S;
	createHost(post: (msg: EnginePortMessage) => void, store: S): EngineHost;
	/** Task 34: the band store the timing head reads; `model-chunk`s route here. */
	createModelStore?(post: (msg: EnginePortMessage) => void): M;
	/** Task 34: the timing head, built over the model store; absent → `timing` answers not-available. */
	createTiming?(store: M): TimingInference;
	/**
	 * 2026-09-11: the Maia-3 policy host (it owns its own bundled-only store, so nothing routes
	 * to it but the queries); absent → `policy` / `policy-warm` answer not-available.
	 */
	createPolicy?(): PolicyInference;
}

export interface ServedEngine {
	host: EngineHost;
	/** Stop accepting connections, dispose the host, the timing head and the policy host. */
	stop(): void;
}

const NO_PORT_DROP_REASON = "port disconnected";

export function serveEnginePort<S extends NnueStoreLike, M extends ModelStoreLike = ModelStoreLike>(
	deps: ServeEngineDeps<S, M>
): ServedEngine {
	let current: AcceptedPort<EnginePortMessage, EnginePortCommand> | null = null;
	const post = (msg: EnginePortMessage): void => {
		if (current) current.post(msg);
		else log.debug("engine-host: no service-worker port; message dropped", { kind: msg.kind });
	};
	const store = deps.createStore(post);
	let host = deps.createHost(post, store);
	const modelStore = deps.createModelStore?.(post);
	const timing = modelStore && deps.createTiming ? deps.createTiming(modelStore) : undefined;
	const policy = deps.createPolicy?.();
	/** The default band is warmed once, on the first `configure` that asks for it. */
	let preWarmed = false;
	/** The Maia size the last `configure.warmPolicy` asked for; a repeat is not warmed again. */
	let preWarmedPolicy: MaiaSize | undefined;

	/**
	 * Load and warm `CHESSMIMIC_DEFAULT_BAND` before the first move needs it. A band's session is
	 * created inside `handle()`, so without this the first query for a band waits out the whole
	 * create + warm-up (~200 ms cold) — past the head's 100 ms budget, which means the first move
	 * silently falls back to v1. Gated on the SW's `warmTiming` because it is ~200 ms of
	 * main-thread wasm work and an 18 MB session that a v1 user must not pay for.
	 */
	const preWarm = (): void => {
		if (!timing || preWarmed) return;
		preWarmed = true;
		void timing.warm(CHESSMIMIC_DEFAULT_BAND);
	};

	/**
	 * Same idea for Maia-3: `configure.warmPolicy` names the size to have resident before the
	 * first move (`MAIA.defaultSize` on connect, the target's size once it is known). One
	 * session is resident at a time, so a different size evicts the last; the same size again
	 * — every reconnect re-sends `configure` — is a no-op here as well as in the host.
	 */
	const preWarmPolicy = (size: MaiaSize): void => {
		if (!policy || preWarmedPolicy === size) return;
		preWarmedPolicy = size;
		void policy.warm(size).then(post);
	};

	const route = (cmd: EnginePortCommand): void => {
		if (!cmd || typeof cmd !== "object") return;
		switch (cmd.kind) {
			case "nnue-chunk":
				store.handleChunk(cmd);
				return;
			case "model-chunk":
				modelStore?.handleChunk(cmd);
				return;
			case "timing":
				if (timing) void timing.handle(cmd).then(post);
				else post({ kind: "timing-result", id: cmd.id, probs: null, error: TIMING_NOT_AVAILABLE });
				return;
			case "timing-warm":
				void timing?.warm(cmd.band);
				return;
			case "policy":
				if (policy) void policy.handle(cmd).then(post);
				else post({ kind: "policy-result", id: cmd.id, moves: null, error: POLICY_NOT_AVAILABLE });
				return;
			case "policy-warm":
				if (policy) void policy.warm(cmd.size).then(post);
				else post({ kind: "policy-status", size: null, error: POLICY_NOT_AVAILABLE });
				return;
			case "configure":
				if (cmd.warmTiming) preWarm();
				if (cmd.warmPolicy) preWarmPolicy(cmd.warmPolicy);
				host.handle(cmd);
				return;
			default:
				host.handle(cmd);
		}
	};

	let unsubscribeCurrent: () => void = () => {};
	const stopAccepting = acceptPorts<EnginePortMessage, EnginePortCommand>(
		deps.portName ?? PORT_NAMES.engine,
		(port) => {
			unsubscribeCurrent();
			current = port;
			const offMessage = port.onMessage((cmd) => {
				if (current === port) route(cmd);
			});
			const offDisconnect = port.onDisconnect(() => {
				offMessage();
				if (current !== port) return;
				current = null;
				store.abortAll(NO_PORT_DROP_REASON);
				modelStore?.abortAll(NO_PORT_DROP_REASON);
				if (deps.disposeOnDisconnect) {
					host.dispose();
					host = deps.createHost(post, store);
				}
			});
			unsubscribeCurrent = () => {
				offMessage();
				offDisconnect();
			};
			log.info("engine-host: service worker connected");
			port.post({ kind: "status", status: host.status() });
		}
	);

	return {
		get host() {
			return host;
		},
		stop() {
			stopAccepting();
			unsubscribeCurrent(); // an `AcceptedPort` cannot be closed from this side; stop routing it
			current = null;
			store.abortAll(NO_PORT_DROP_REASON);
			modelStore?.abortAll(NO_PORT_DROP_REASON);
			timing?.dispose();
			policy?.dispose();
			host.dispose();
		},
	};
}
