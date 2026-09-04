/**
 * `RemoteEngine` — the service-worker side `EngineTransport` (§6.4,
 * Appendix E §6.3 `PortTransport`). `UciEngine` runs in the SW; the engine
 * runs in the offscreen document; this class bridges them over
 * `PORT_NAMES.engine`:
 *
 *   - `ensureHost()` (Task 9's `ensureOffscreen`, injected at integration —
 *     default no-op) is awaited, then `connectPort` opens the port. The
 *     offscreen document accepts and replies with its current status; that
 *     first status marks the transport `ready` (a `searching` engine left over
 *     from a previous SW life is told to `stop`).
 *   - `send(line)` never throws: lines queue until the port exists and are
 *     dropped with a warning after `dispose()`.
 *   - `restart()` posts `{kind:"restart"}` and settles when the host reports
 *     `ready`, or rejects after `TIMINGS.engineReadyTimeoutMs`.
 *   - `configure` (variant, threads) is sent on connect and re-sent on the
 *     first status after a reconnect (the document may be a fresh one).
 *
 * Wiring `bootstrapServiceSystems().engine = new UciEngine(new RemoteEngine({
 * ensureHost: ensureOffscreen }))` is Task 30's (controller ruling).
 */

import { DEFAULT_ENGINE_STATUS } from "@core/constants/defaults";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { type ConnectedPort, connectPort, type PortScheduler } from "@core/messaging/ports";
import type { EngineStatus, EngineVariant } from "@typedefs/engine";
import type { EngineTransport } from "./types";

export interface RemoteEngineOptions {
	/** Makes sure the offscreen document exists (Task 9 `ensureOffscreen`). Default: no-op. */
	ensureHost?: () => Promise<void>;
	/** Drives the port's reconnect backoff and the restart timeout (tests inject a fake). */
	scheduler?: PortScheduler;
	readyTimeoutMs?: number;
	variant?: EngineVariant;
	threads?: number;
}

interface RestartWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: unknown;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RemoteEngine implements EngineTransport {
	/** Resolves once the host has reported its status over a live port. */
	readonly ready: Promise<void>;
	private resolveReady: () => void = () => {};
	private readonly ensureHost: () => Promise<void>;
	private readonly scheduler: PortScheduler;
	private readonly readyTimeoutMs: number;
	private port: ConnectedPort<EnginePortCommand> | undefined;
	private queue: string[] = [];
	private variant: EngineVariant | undefined;
	private threads: number | undefined;
	private needsConfigure = true;
	private synced = false;
	private last: EngineStatus | undefined;
	private disposed = false;
	private readonly lineCbs = new Set<(line: string) => void>();
	private readonly statusCbs = new Set<(s: EngineStatus) => void>();
	private readonly messageCbs = new Set<(m: EnginePortMessage) => void>();
	private restartWaiters: RestartWaiter[] = [];

	constructor(opts: RemoteEngineOptions = {}) {
		this.ensureHost = opts.ensureHost ?? (() => Promise.resolve());
		this.scheduler = opts.scheduler ?? {
			setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
			clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.readyTimeoutMs = opts.readyTimeoutMs ?? TIMINGS.engineReadyTimeoutMs;
		if (opts.variant !== undefined) this.variant = opts.variant;
		if (opts.threads !== undefined) this.threads = opts.threads;
		this.ready = new Promise<void>((resolve) => {
			this.resolveReady = resolve;
		});
		void this.connect();
	}

	// ── EngineTransport ──────────────────────────────────────────────────

	send(line: string): void {
		if (this.disposed) {
			log.warn("remote-engine: send after dispose dropped", { line });
			return;
		}
		if (!this.port) {
			this.queue.push(line);
			return;
		}
		this.post({ kind: "uci", line });
	}

	onLine(cb: (line: string) => void): () => void {
		this.lineCbs.add(cb);
		return () => this.lineCbs.delete(cb);
	}

	onStatus(cb: (s: EngineStatus) => void): () => void {
		this.statusCbs.add(cb);
		return () => this.statusCbs.delete(cb);
	}

	restart(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("remote-engine: disposed"));
		return new Promise<void>((resolve, reject) => {
			const waiter: RestartWaiter = { resolve, reject, timer: undefined };
			waiter.timer = this.scheduler.setTimeout(() => {
				this.restartWaiters = this.restartWaiters.filter((w) => w !== waiter);
				reject(new Error("remote-engine: timed out waiting for the engine to become ready"));
			}, this.readyTimeoutMs);
			this.restartWaiters.push(waiter);
			this.post({ kind: "restart" });
		});
	}

	// ── extras used by the SW handlers / bootstrap ───────────────────────

	/** Every message from the host (lines and statuses included). */
	onMessage(cb: (m: EnginePortMessage) => void): () => void {
		this.messageCbs.add(cb);
		return () => this.messageCbs.delete(cb);
	}

	/** Post any command; never throws (queued by the port until it is live). */
	post(cmd: EnginePortCommand): void {
		if (this.disposed) {
			log.warn("remote-engine: post after dispose dropped", { kind: cmd.kind });
			return;
		}
		try {
			this.port?.post(cmd);
		} catch (error) {
			log.warn("remote-engine: post failed", { kind: cmd.kind, error: errorMessage(error) });
		}
	}

	configure(variant: EngineVariant, threads: number): void {
		this.variant = variant;
		this.threads = threads;
		if (this.port) this.post({ kind: "configure", variant, threads });
	}

	loadNnue(names: string[]): void {
		this.post({ kind: "loadNnue", names: [...names] });
	}

	/** Last status reported by the host (`DEFAULT_ENGINE_STATUS` until the first one). */
	status(): EngineStatus {
		return this.last ?? { ...DEFAULT_ENGINE_STATUS, nnue: [] };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const waiters = this.restartWaiters;
		this.restartWaiters = [];
		for (const w of waiters) {
			this.scheduler.clearTimeout(w.timer);
			w.reject(new Error("remote-engine: disposed"));
		}
		this.queue = [];
		this.port?.disconnect();
		this.port = undefined;
		this.lineCbs.clear();
		this.statusCbs.clear();
		this.messageCbs.clear();
		this.resolveReady();
	}

	// ── internals ────────────────────────────────────────────────────────

	private async connect(): Promise<void> {
		try {
			await this.ensureHost();
		} catch (error) {
			log.error("remote-engine: ensureHost failed; connecting anyway", {
				error: errorMessage(error),
			});
		}
		if (this.disposed) return;
		this.port = connectPort<EnginePortCommand, EnginePortMessage>(PORT_NAMES.engine, {
			onMessage: (m) => this.onPortMessage(m),
			onDisconnect: (reason) => {
				this.synced = false;
				this.needsConfigure = true;
				log.info("remote-engine: port disconnected; will reconnect", { reason: reason ?? null });
				// The document may be gone — recreate it so the port's backoff retries land.
				this.ensureHost().catch((error: unknown) =>
					log.error("remote-engine: ensureHost failed after disconnect", {
						error: errorMessage(error),
					})
				);
			},
			scheduler: this.scheduler,
		});
		this.postConfigure();
		const queued = this.queue;
		this.queue = [];
		for (const line of queued) this.post({ kind: "uci", line });
	}

	private postConfigure(): void {
		this.needsConfigure = false;
		if (this.variant === undefined) return;
		this.post({ kind: "configure", variant: this.variant, threads: this.threads ?? 1 });
	}

	private onPortMessage(m: EnginePortMessage): void {
		if (this.disposed || !m || typeof m !== "object") return;
		switch (m.kind) {
			case "line":
				for (const cb of [...this.lineCbs]) cb(m.line);
				break;
			case "status":
				this.onStatusMessage(m.status);
				break;
			default:
				break;
		}
		for (const cb of [...this.messageCbs]) cb(m);
	}

	private onStatusMessage(status: EngineStatus): void {
		this.last = status;
		if (!this.synced) {
			this.synced = true;
			if (this.needsConfigure) this.postConfigure();
			if (status.state === "searching") this.post({ kind: "uci", line: "stop" });
			this.resolveReady();
		}
		if (status.state === "ready") {
			const waiters = this.restartWaiters;
			this.restartWaiters = [];
			for (const w of waiters) {
				this.scheduler.clearTimeout(w.timer);
				w.resolve();
			}
		}
		for (const cb of [...this.statusCbs]) cb(status);
	}
}
