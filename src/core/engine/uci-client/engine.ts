/**
 * `UciEngine` — the coordinator. State machine `idle → searching → stopping → idle` plus
 * `initialising` / `crashed`; one search at a time drawn from the priority queue; handshakes,
 * option bursts and `ucinewgame` are serialised idle-state operations; a crash of an
 * initialised engine restarts the transport and replays the applied options.
 */

import { TIMINGS } from "@core/constants/timings";
import { newId } from "@core/util/ids";
import { DEFAULT_SCHEDULER } from "@core/util/scheduler";
import type {
	AnalysisHandle,
	AnalysisRequest,
	EngineInfo,
	EngineOptions,
	EngineState,
	EngineTransport,
	UciOptionSpec,
} from "../types";
import { parseBestmove, parseId, parseInfo, parseOption } from "../uci-parser";
import { AppliedOptions } from "./applied-options";
import { goArgs, positionCommand, searchBudget } from "./commands";
import { type PendingContext, PendingSearch } from "./pending-search";
import { ReadyWaiters } from "./ready-waiters";
import type { UciScheduler } from "./scheduler";
import { SearchQueue } from "./search-queue";

export interface UciEngineOptions {
	/** `uciok` / `readyok` timeout (default `TIMINGS.engineReadyTimeoutMs`). */
	readyTimeoutMs?: number;
	/** `bestmove` after `stop` timeout (default `TIMINGS.engineStopTimeoutMs`). */
	stopTimeoutMs?: number;
	/** Partial-iteration update interval (default `TIMINGS.engineInfoCoalesceMs`). */
	coalesceMs?: number;
	scheduler?: UciScheduler;
}

export class UciEngine {
	private st: EngineState = "idle";
	private initialised = false;
	/** A handshake or option burst is in flight: no `position`/`go` until it ends. */
	private busy = false;
	private recovering = false;
	private disposed = false;
	private readonly queue = new SearchQueue();
	private active: PendingSearch | undefined;
	/** Applied options in application order (replayed after a restart). */
	private readonly applied: AppliedOptions;
	private readonly waiters: ReadyWaiters;
	private initInfo: EngineInfo = { name: "", author: "", options: {} };
	private stopTimer: unknown;
	private chain: Promise<void> | undefined;
	private readonly unsubscribe: Array<() => void>;
	private readonly sched: UciScheduler;
	private readonly stopTimeoutMs: number;
	private readonly pendingCtx: PendingContext;

	constructor(
		private readonly transport: EngineTransport,
		opts: UciEngineOptions = {}
	) {
		this.sched = opts.scheduler ?? DEFAULT_SCHEDULER;
		this.stopTimeoutMs = opts.stopTimeoutMs ?? TIMINGS.engineStopTimeoutMs;
		this.applied = new AppliedOptions((line) => this.transport.send(line));
		this.waiters = new ReadyWaiters(
			this.sched,
			opts.readyTimeoutMs ?? TIMINGS.engineReadyTimeoutMs,
			(kind) => this.onCrash(`timeout waiting for ${kind}`)
		);
		this.pendingCtx = {
			sched: this.sched,
			coalesceMs: opts.coalesceMs ?? TIMINGS.engineInfoCoalesceMs,
			stop: (p) => this.stopRequest(p),
		};
		this.unsubscribe = [
			transport.onLine((line) => this.onLine(line)),
			transport.onStatus((s) => {
				if (s.state === "crashed") this.onCrash("transport crashed");
			}),
		];
	}

	state(): EngineState {
		return this.st;
	}

	/** `uci` → `uciok` (collecting `id`/`option` lines), replayed options, `isready` → `readyok`. */
	init(): Promise<EngineInfo> {
		if (this.disposed) return Promise.reject(new Error("UciEngine.init: disposed"));
		if (this.st === "searching" || this.st === "stopping")
			return Promise.reject(new Error("UciEngine.init: refused while searching"));
		if (this.recovering) return Promise.reject(new Error("UciEngine.init: recovery in progress"));
		if (this.st === "initialising")
			return Promise.reject(new Error("UciEngine.init: already initialising"));
		return this.handshake(false);
	}

	/** Replace a stopped engine, then replay all options before admitting queued searches. */
	reconfigure(replace: () => Promise<void>, options: EngineOptions): Promise<EngineInfo> {
		return this.serial(async () => {
			if (this.disposed || (this.st !== "idle" && this.st !== "crashed"))
				throw new Error(`UciEngine.reconfigure: refused while ${this.st}`);
			this.initialised = false;
			this.busy = true;
			this.st = "initialising";
			try {
				await replace();
				if (this.disposed) throw new Error("UciEngine.reconfigure: disposed");
				this.applied.record(options);
				return await this.handshake(true);
			} catch (error) {
				this.st = "crashed";
				this.queue.failAll();
				throw error;
			} finally {
				this.busy = false;
			}
		});
	}

	/** Diffed against the applied options; only changes are sent, then `isready`. */
	setOptions(opts: Partial<EngineOptions>): Promise<void> {
		return this.serial(async () => {
			this.assertIdle("setOptions");
			const changed = this.applied.changes(opts);
			if (changed.length === 0) return;
			this.busy = true;
			try {
				for (const [name, value] of changed) this.applied.apply(name, value);
				await this.isReady();
			} finally {
				this.busy = false;
				this.pump();
			}
		});
	}

	newGame(): Promise<void> {
		return this.serial(async () => {
			this.assertIdle("newGame");
			this.busy = true;
			try {
				this.transport.send("ucinewgame");
				await this.isReady();
			} finally {
				this.busy = false;
				this.pump();
			}
		});
	}

	/**
	 * Queued; a request supersedes a running search of equal or lower priority,
	 * and any request supersedes a running ponder. Fails immediately when the
	 * engine is crashed with no recovery in flight (call `init()` first).
	 */
	analyse(req: AnalysisRequest): AnalysisHandle {
		const p = new PendingSearch(req, this.pendingCtx);
		if (this.disposed || (this.st === "crashed" && !this.recovering)) {
			p.fail();
			return p.handle();
		}
		this.queue.enqueue(p);
		const active = this.active;
		if (active && this.st === "searching" && (p.rank <= active.rank || active.priority === "ponder"))
			this.stopActive(active, "superseded");
		this.pump();
		return p.handle();
	}

	/** `go infinite` at the current strength; cancelled by the next `analyse` or `ponderMaxMs`. */
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

	/** Stops listening and fails every outstanding request. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.unsubscribe) off();
		this.clearStopTimer();
		this.waiters.rejectAll(new Error("UciEngine: disposed"));
		const active = this.active;
		this.active = undefined;
		active?.fail();
		this.queue.failAll();
		this.st = "crashed";
	}

	private assertIdle(op: string): void {
		if (this.disposed) throw new Error(`UciEngine.${op}: disposed`);
		if (!this.initialised) throw new Error(`UciEngine.${op}: not initialised`);
		if (this.st !== "idle") throw new Error(`UciEngine.${op}: refused while ${this.st}`);
	}

	/** Serialises idle-state operations; runs `fn` synchronously when nothing is in flight. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.chain;
		const run = prev ? prev.then(fn) : fn();
		const settled = run.then(
			() => undefined,
			() => undefined
		);
		this.chain = settled;
		void settled.then(() => {
			if (this.chain === settled) this.chain = undefined;
		});
		return run;
	}

	private async handshake(newGame: boolean): Promise<EngineInfo> {
		this.st = "initialising";
		this.busy = true;
		this.initInfo = { name: "", author: "", options: {} };
		try {
			await this.waiters.sendAndWait("uciok", () => this.transport.send("uci"));
			this.applied.replay();
			if (newGame) this.transport.send("ucinewgame");
			await this.isReady();
			this.st = "idle";
			this.initialised = true;
			return this.initInfo;
		} catch (err) {
			if (this.st === "initialising") this.st = "crashed";
			// A request made before `init()` resolved is *queued* (`pump` bails on `!initialised`), and
			// the `finally` below can only drain a queue into an *idle* engine — so a handshake that
			// fails must settle it here or those promises are never settled at all. Callers above have
			// no timeout of their own (`RecommendationPipeline.runSearch` awaits `handle.result`), and
			// an unsettled search wedges a `GameSession` in `live:my-turn:analysing` for the rest of
			// the game: at ply 0 as white no later position arrives to reset it.
			//
			// The timeout legs reach this through `onCrash` (`sendAndWait`'s timer), which fails the
			// queue itself; a synchronous `transport.send` throw — the `void` sync API the client
			// already defends against — does not, and neither does a throw from the option replay or
			// `ucinewgame` below it. One settle here covers every way the handshake can end badly.
			//
			// As of 2026-09-10 the throwing leg is **unreachable through the shipped transport**: the
			// only production `UciEngine` is built over `RemoteEngine` (`game-stack.ts`), whose `post`
			// catches and logs rather than throwing. So this line keeps a contract rather than fixing a
			// live hang — and it is the line that has to be here if `RemoteEngine.post` ever rethrows,
			// or a second transport appears, because the hang it prevents is silent and permanent.
			this.queue.failAll();
			throw err;
		} finally {
			this.busy = false;
			this.pump();
		}
	}

	private isReady(): Promise<void> {
		return this.waiters.sendAndWait("readyok", () => this.transport.send("isready"));
	}

	private pump(): void {
		if (this.st !== "idle" || !this.initialised || this.busy || this.active) return;
		const p = this.queue.shift();
		if (!p) return;
		this.active = p;
		this.st = "searching";
		const { fen, moves, multiPv, limit, searchmoves, elo } = p.req;
		this.applied.applyStrength(elo);
		this.applied.apply("MultiPV", multiPv);
		this.transport.send(positionCommand(fen, moves));
		this.transport.send(`go ${goArgs(limit, searchmoves)}`);
		const budget = searchBudget(limit, p.priority, this.stopTimeoutMs);
		if (budget !== undefined) {
			p.deadline = this.sched.setTimeout(() => {
				p.deadline = undefined;
				this.stopActive(p, "complete");
			}, budget);
		}
	}

	/** `stop`, then wait for `bestmove` (the stop timeout is the crash path). */
	private stopActive(p: PendingSearch, status: "complete" | "superseded"): void {
		if (this.active !== p || this.st !== "searching") return;
		this.st = "stopping";
		if (status === "superseded") p.status = "superseded";
		p.clearDeadline();
		this.transport.send("stop");
		this.stopTimer = this.sched.setTimeout(() => {
			this.stopTimer = undefined;
			this.onCrash("timeout waiting for bestmove after stop");
		}, this.stopTimeoutMs);
	}

	private clearStopTimer(): void {
		if (this.stopTimer === undefined) return;
		this.sched.clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
	}

	private stopRequest(p: PendingSearch): Promise<void> {
		if (p.finished) return Promise.resolve();
		if (this.active === p) {
			this.stopActive(p, "complete");
			return p.done;
		}
		this.queue.remove(p);
		p.status = "superseded";
		p.finish({ bestmove: null });
		return Promise.resolve();
	}

	private onLine(line: string): void {
		if (this.disposed) return;
		if (line.startsWith("info")) {
			const info = parseInfo(line);
			if (info && this.active) this.active.push(info);
			return;
		}
		if (line.startsWith("bestmove")) {
			const bm = parseBestmove(line);
			if (!bm) return;
			this.clearStopTimer();
			const p = this.active;
			this.active = undefined;
			if (this.st === "searching" || this.st === "stopping") this.st = "idle";
			p?.finish(bm);
			this.pump();
			return;
		}
		if (line === "uciok" || line === "readyok") {
			this.waiters.settle(line);
			return;
		}
		if (this.st === "initialising") this.collectInit(line);
	}

	private collectInit(line: string): void {
		const id = parseId(line);
		if (id) {
			this.initInfo[id.key] = id.value;
			return;
		}
		const opt = parseOption(line);
		if (opt) this.initInfo.options[opt.name] = opt.spec satisfies UciOptionSpec;
	}

	private onCrash(reason: string): void {
		if (this.disposed) return;
		const wasInitialised = this.initialised;
		this.initialised = false;
		this.st = "crashed";
		this.clearStopTimer();
		const active = this.active;
		this.active = undefined;
		active?.fail();
		this.waiters.rejectAll(new Error(`UciEngine: engine crashed (${reason})`));
		if (this.recovering) return;
		if (wasInitialised) void this.recover();
		else this.queue.failAll();
	}

	/** `restart()`, then `uci`, the applied options in order, `ucinewgame`, `isready`; then drain. */
	private async recover(): Promise<void> {
		this.recovering = true;
		try {
			await this.transport.restart();
			if (this.disposed) return;
			await this.handshake(true);
		} catch {
			this.st = "crashed";
			this.queue.failAll();
		} finally {
			this.recovering = false;
		}
	}
}
