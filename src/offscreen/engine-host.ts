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
 * routed; its disconnect aborts pending NNUE downloads.
 */

import type { EnginePortCommand, EnginePortMessage, NnueChunk } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import type StockfishWeb from "@lichess-org/stockfish-web";
import type { EngineStatus, EngineVariant } from "@typedefs/engine";
import type { BootedEngine, NnueSource } from "./stockfish-loader";
import { TIMING_NOT_AVAILABLE, type TimingInference } from "./timing-inference";

export interface HostScheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

const DEFAULT_SCHEDULER: HostScheduler = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

/** What the loader needs from the host for one engine instance. */
export interface BootHooks {
	listen(line: string): void;
	onError(msg: string): void;
	onLoadingNnue(names: string[]): void;
}

export interface EngineHostDeps {
	boot(variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine>;
	nnueStore: NnueSource;
	post(msg: EnginePortMessage): void;
	scheduler?: HostScheduler;
}

const INITIAL_STATUS: EngineStatus = {
	state: "booting",
	variant: "smallnet",
	threads: 1,
	nnue: [],
	version: "",
};

const MULTIPV_RE = /\bmultipv (\d+)/;
const NPS_RE = /\bnps (\d+)/;
const THREADS_OPTION_RE = /^setoption name Threads value (\d+)\s*$/;
const ID_NAME_PREFIX = "id name ";
const NOOP = (): void => {};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class EngineHost {
	private readonly sched: HostScheduler;
	private readonly st: EngineStatus = { ...INITIAL_STATUS, nnue: [] };
	private sf: StockfishWeb | undefined;
	private started = false;
	private booting = false;
	/** Bumped on every boot/teardown so callbacks from a superseded instance are ignored. */
	private seq = 0;
	private queued: string[] = [];
	private pendingNnue: string[] | undefined;
	private attempt = 0;
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
				this.restart();
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
		if (variant !== this.st.variant) {
			this.st.variant = variant;
			this.restart();
			return;
		}
		if (threadsChanged) this.postStatus();
	}

	private uci(line: string): void {
		if (!this.started) this.configure(this.st.variant, this.st.threads);
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

	private restart(): void {
		this.cancelReboot();
		this.attempt = 0;
		this.teardownEngine();
		this.startBoot();
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
		this.teardownEngine();
		this.clearFlush();
		this.pendingInfo.clear();
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
		if (line.startsWith(ID_NAME_PREFIX)) this.st.version = line.slice(ID_NAME_PREFIX.length).trim();
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

export interface ServeEngineDeps<S extends NnueStoreLike> {
	createStore(post: (msg: EnginePortMessage) => void): S;
	createHost(post: (msg: EnginePortMessage) => void, store: S): EngineHost;
	timing?: TimingInference;
}

export interface ServedEngine {
	host: EngineHost;
	/** Stop accepting connections, dispose the host and the timing head. */
	stop(): void;
}

const NO_PORT_DROP_REASON = "port disconnected";

export function serveEnginePort<S extends NnueStoreLike>(deps: ServeEngineDeps<S>): ServedEngine {
	let current: AcceptedPort<EnginePortMessage, EnginePortCommand> | null = null;
	const post = (msg: EnginePortMessage): void => {
		if (current) current.post(msg);
		else log.debug("engine-host: no service-worker port; message dropped", { kind: msg.kind });
	};
	const store = deps.createStore(post);
	const host = deps.createHost(post, store);

	const route = (cmd: EnginePortCommand): void => {
		if (!cmd || typeof cmd !== "object") return;
		switch (cmd.kind) {
			case "nnue-chunk":
				store.handleChunk(cmd);
				return;
			case "timing":
				if (deps.timing) post(deps.timing.handle(cmd));
				else post({ kind: "timing-result", id: cmd.id, probs: null, error: TIMING_NOT_AVAILABLE });
				return;
			default:
				host.handle(cmd);
		}
	};

	const stopAccepting = acceptPorts<EnginePortMessage, EnginePortCommand>(
		PORT_NAMES.engine,
		(port) => {
			current = port;
			const offMessage = port.onMessage((cmd) => {
				if (current === port) route(cmd);
			});
			port.onDisconnect(() => {
				offMessage();
				if (current !== port) return;
				current = null;
				store.abortAll(NO_PORT_DROP_REASON);
			});
			log.info("engine-host: service worker connected");
			port.post({ kind: "status", status: host.status() });
		}
	);

	return {
		host,
		stop() {
			stopAccepting();
			current = null;
			deps.timing?.dispose();
			host.dispose();
		},
	};
}
