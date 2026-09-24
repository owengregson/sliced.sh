// src/offscreen/engine-host/host.ts
/**
 * `EngineHost` owns exactly one Stockfish instance and speaks the engine port protocol
 * (`EnginePortCommand` in, `EnginePortMessage` out) — the lifecycle half of `engine-host.ts`;
 * see there for the protocol. Its parts: `InfoCoalescer` (the §6.4 backpressure on `info`
 * lines), `RebootBackoff` (the crash-reboot steps) and `uci-lines.ts` (what is read from the
 * relayed traffic).
 */

import { DEFAULT_ENGINE_STATUS } from "@core/constants/defaults";
import type { EnginePortCommand } from "@core/constants/messages";
import { log } from "@core/logger";
import { DEFAULT_SCHEDULER } from "@core/util/scheduler";
import type StockfishWeb from "@lichess-org/stockfish-web";
import type { EngineStatus, EngineVariant } from "@typedefs/engine";
import { errorMessage } from "../shared/errors";
import { InfoCoalescer } from "./info-coalescer";
import { RebootBackoff } from "./reboot-backoff";
import type { BootHooks, EngineHostDeps, HostScheduler } from "./types";
import { idName, isBadNnue, multipvOf, npsOf, quit, threadsOption } from "./uci-lines";

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
	private readonly reboots: RebootBackoff;
	/**
	 * The variant the service worker asked for while the host runs the small-net build in its
	 * place: the full build crashed twice in a row (2026-09-12, pthread worker faults on the
	 * owner's machine), and a game with no engine is worse than a game on the small net. An
	 * explicit `restart` (the panel's button) tries the requested build again.
	 */
	private fallbackFrom: EngineVariant | undefined;
	private readonly info: InfoCoalescer;
	private disposed = false;

	constructor(private readonly deps: EngineHostDeps) {
		this.sched = deps.scheduler ?? DEFAULT_SCHEDULER;
		this.reboots = new RebootBackoff(this.sched);
		this.info = new InfoCoalescer(this.sched, (line) => this.deps.post({ kind: "line", line }));
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
		this.reboots.cancel();
		this.info.reset();
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
		const threads = threadsOption(line);
		if (threads !== undefined) this.st.threads = threads;
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
		return !this.sf && !this.booting && !this.reboots.pending;
	}

	private restart(): void {
		this.reboots.cancel();
		this.reboots.attempt = 0;
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
		if (this.st.variant !== "full" || this.fallbackFrom !== undefined || this.reboots.attempt < 1)
			return false;
		log.warn("engine-host: the full build crashed again; running the small-net build instead", {
			attempt: this.reboots.attempt,
		});
		this.fallbackFrom = "full";
		this.st.fallbackFrom = "full";
		this.st.variant = "smallnet";
		this.st.nnue = [];
		this.reboots.attempt = 0;
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
		this.info.reset();
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
		log.error("engine-host: engine crashed", { message, attempt: this.reboots.attempt });
		this.reboots.cancel(); // a second entry must not burn another backoff step
		this.teardownEngine();
		this.info.reset();
		if (isBadNnue(message)) this.evictNets();
		this.fallBackIfRepeated();
		this.setState("crashed", message);
		if (!this.reboots.arm(() => this.startBoot())) {
			log.error("engine-host: giving up after the last backoff step", { message });
		}
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

	// ── output ───────────────────────────────────────────────────────────

	private onLine(line: string): void {
		if (line.startsWith("info")) {
			if (line.startsWith("info string")) {
				this.info.flush();
				this.deps.post({ kind: "line", line });
				return;
			}
			if (line.includes(" currmove ")) return; // progress noise (§6.4)
			const nps = npsOf(line);
			if (nps !== undefined) this.st.nps = nps;
			this.info.add(multipvOf(line), line);
			return;
		}
		this.info.flush();
		const name = idName(line);
		if (name !== undefined) {
			this.st.version = name;
			// Publish the identity during the handshake, before `uciok` can finish warming.
			// Otherwise the remote reviewer captures the boot module's filename, sees this
			// name only on the first `go` status, and rejects every search as a network change.
			this.postStatus();
		}
		this.deps.post({ kind: "line", line });
		if (line.startsWith("bestmove")) {
			this.reboots.attempt = 0;
			if (this.st.state === "searching") this.setState("ready");
		}
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
