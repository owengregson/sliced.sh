/**
 * Typed UCI client (§6.4, Appendix E §5). State machine
 * `idle → searching → stopping → idle` plus `initialising` / `crashed`; one
 * search at a time drawn from a priority FIFO (`move` > `ponder` > `panel`);
 * per-request accumulation of the latest line per multipv index, delivered
 * through a single-slot mailbox when a depth iteration completes or every
 * `TIMINGS.engineInfoCoalesceMs` for partial iterations. Pure: the transport
 * and the timers are injected.
 */

import { applyMoves, pvToSan } from "@core/chess/san";
import { LIMITS } from "@core/constants/limits";
import { TIMINGS } from "@core/constants/timings";
import { newId } from "@core/util/ids";
import type { Eval, EvalLine } from "@typedefs/engine";
import { formatSetOption } from "./options";
import type {
	AnalysisHandle,
	AnalysisPriority,
	AnalysisRequest,
	AnalysisResult,
	AnalysisStatus,
	AnalysisUpdate,
	EngineInfo,
	EngineOptions,
	EngineOptionValue,
	EngineState,
	EngineTransport,
	UciOptionSpec,
} from "./types";
import {
	type Bestmove,
	type Info,
	isInterimBoundLine,
	parseBestmove,
	parseId,
	parseInfo,
	parseOption,
} from "./uci-parser";

/** The timing model's fixed feature depth `D_f` (§6.5, Appendix D §2); lives in `LIMITS`. */
export const FEATURE_DEPTH: number = LIMITS.featureDepth;

/** `cpEquivalent` of a mate: `±(MATE_CP − MATE_CP_PER_PLY · plies)`. */
const MATE_CP = 2000;
const MATE_CP_PER_PLY = 10;

/**
 * Scalar centipawns for consumers that need one. UCI `mate n` is in moves;
 * the mating side needs `2n − 1` plies, the mated side `2n`. `mate 0` (the
 * side to move is checkmated) maps to `−MATE_CP`.
 */
export function cpEquivalent(score: Eval): number {
	if (score.mate !== undefined) {
		const m = score.mate;
		if (m === 0) return -MATE_CP;
		const plies = m > 0 ? 2 * m - 1 : -2 * m;
		return Math.sign(m) * Math.max(0, MATE_CP - MATE_CP_PER_PLY * plies);
	}
	return score.cp ?? 0;
}

export interface UciScheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

const DEFAULT_SCHEDULER: UciScheduler = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

export interface UciEngineOptions {
	/** `uciok` / `readyok` timeout (default `TIMINGS.engineReadyTimeoutMs`). */
	readyTimeoutMs?: number;
	/** `bestmove` after `stop` timeout (default `TIMINGS.engineStopTimeoutMs`). */
	stopTimeoutMs?: number;
	/** Partial-iteration update interval (default `TIMINGS.engineInfoCoalesceMs`). */
	coalesceMs?: number;
	scheduler?: UciScheduler;
}

const PRIORITY_RANK: Readonly<Record<AnalysisPriority, number>> = { move: 0, ponder: 1, panel: 2 };

type WaitKind = "uciok" | "readyok";

interface Waiter {
	kind: WaitKind;
	resolve: () => void;
	reject: (err: Error) => void;
	timer: unknown;
}

interface PendingContext {
	sched: UciScheduler;
	coalesceMs: number;
	stop(p: Pending): Promise<void>;
}

/** Newest-wins mailbox: a slow consumer never sees a backlog of stale frames. */
class Mailbox<T> implements AsyncIterable<T> {
	private slot: T | undefined;
	private closed = false;
	private wake: (() => void) | undefined;

	put(value: T): void {
		this.slot = value;
		this.signal();
	}

	close(): void {
		this.closed = true;
		this.signal();
	}

	private signal(): void {
		const w = this.wake;
		this.wake = undefined;
		w?.();
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: async (): Promise<IteratorResult<T>> => {
				for (;;) {
					if (this.slot !== undefined) {
						const value = this.slot;
						this.slot = undefined;
						return { value, done: false };
					}
					if (this.closed) return { value: undefined, done: true };
					await new Promise<void>((resolve) => {
						const prev = this.wake;
						this.wake = () => {
							prev?.();
							resolve();
						};
					});
				}
			},
			return: async (): Promise<IteratorResult<T>> => ({ value: undefined, done: true }),
		};
	}
}

function toEval(score: NonNullable<Info["score"]>): Eval {
	return score.type === "mate" ? { mate: score.value } : { cp: score.value };
}

/** One queued or running analysis: accumulates lines and owns the handle. */
class Pending {
	readonly priority: AnalysisPriority;
	readonly rank: number;
	status: AnalysisStatus = "complete";
	finished = false;
	deadline: unknown;
	readonly result: Promise<AnalysisResult>;
	readonly done: Promise<void>;
	private resolveResult: (r: AnalysisResult) => void = () => {};
	private readonly mailbox = new Mailbox<AnalysisUpdate>();
	private readonly latest = new Map<number, Info>();
	private last: Info | undefined;
	private iterDepth = 0;
	private readonly seen = new Set<number>();
	private atFeatureDepth: AnalysisUpdate | undefined;
	private flushTimer: unknown;
	private lastEmitAt = Number.NEGATIVE_INFINITY;
	private readonly sanMemo = new Map<string, string[]>();
	private positionFen: string | null | undefined;

	constructor(
		readonly req: AnalysisRequest,
		private readonly ctx: PendingContext
	) {
		this.priority = req.priority ?? "move";
		this.rank = PRIORITY_RANK[this.priority];
		this.result = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		this.done = this.result.then(() => undefined);
	}

	handle(): AnalysisHandle {
		return {
			id: this.req.id,
			updates: this.mailbox,
			result: this.result,
			stop: () => this.ctx.stop(this),
		};
	}

	get complete(): boolean {
		return this.seen.size >= this.req.multiPv;
	}

	push(info: Info): void {
		if (this.finished) return;
		if (
			info.string !== undefined ||
			info.pv === undefined ||
			info.depth === undefined ||
			info.score === undefined ||
			isInterimBoundLine(info)
		)
			return;
		const k = info.multipv ?? 1;
		if (info.depth < this.iterDepth) return;
		if (info.depth > this.iterDepth) {
			this.captureFeatureDepth();
			this.iterDepth = info.depth;
			this.seen.clear();
		}
		const prev = this.latest.get(k);
		if (
			prev?.depth === info.depth &&
			prev.score?.bound === undefined &&
			info.score.bound !== undefined
		)
			return;
		this.latest.set(k, info);
		this.last = info;
		const wasComplete = this.complete;
		this.seen.add(k);
		if (this.complete && !wasComplete) this.emit();
		else this.scheduleFlush();
	}

	/** Called when the current iteration is left (or on finish): keep depth 10 if it completed. */
	private captureFeatureDepth(): void {
		if (this.iterDepth === FEATURE_DEPTH && this.complete) this.atFeatureDepth = this.snapshot();
	}

	private emit(): void {
		this.clearFlush();
		this.lastEmitAt = this.ctx.sched.now();
		this.mailbox.put(this.snapshot());
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) return;
		const elapsed = this.ctx.sched.now() - this.lastEmitAt;
		const wait = Math.max(0, this.ctx.coalesceMs - elapsed);
		this.flushTimer = this.ctx.sched.setTimeout(() => {
			this.flushTimer = undefined;
			this.emit();
		}, wait);
	}

	private clearFlush(): void {
		if (this.flushTimer === undefined) return;
		this.ctx.sched.clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}

	clearDeadline(): void {
		if (this.deadline === undefined) return;
		this.ctx.sched.clearTimeout(this.deadline);
		this.deadline = undefined;
	}

	private san(pv: string[]): string[] {
		const key = pv.join(" ");
		const memo = this.sanMemo.get(key);
		if (memo) return memo;
		if (this.positionFen === undefined) {
			const { fen, moves } = this.req;
			this.positionFen = moves && moves.length > 0 ? applyMoves(fen, moves) : fen;
		}
		const out = this.positionFen === null ? [] : pvToSan(this.positionFen, pv);
		this.sanMemo.set(key, out);
		return out;
	}

	private snapshot(): AnalysisUpdate {
		const lines: EvalLine[] = [...this.latest.entries()]
			.sort(([a], [b]) => a - b)
			.map(([multipv, info]) => {
				const pv = info.pv ?? [];
				const line: EvalLine = {
					multipv,
					score: info.score ? toEval(info.score) : {},
					depth: info.depth ?? 0,
					pvUci: pv,
					pvSan: this.san(pv),
				};
				if (info.seldepth !== undefined) line.seldepth = info.seldepth;
				if (info.wdl !== undefined) line.wdl = info.wdl;
				if (info.score?.bound !== undefined) line.bound = info.score.bound;
				return line;
			});
		const u: AnalysisUpdate = {
			id: this.req.id,
			depth: this.iterDepth,
			lines,
			nodes: this.last?.nodes ?? 0,
			nps: this.last?.nps ?? 0,
			timeMs: this.last?.time ?? 0,
			complete: this.latest.size > 0 && this.complete,
		};
		const seldepth = this.latest.get(1)?.seldepth ?? this.last?.seldepth;
		if (seldepth !== undefined) u.seldepth = seldepth;
		return u;
	}

	finish(bm: Bestmove): void {
		if (this.finished) return;
		this.finished = true;
		this.clearFlush();
		this.clearDeadline();
		this.captureFeatureDepth();
		const final = this.snapshot();
		const result: AnalysisResult = {
			id: this.req.id,
			bestmove: bm.bestmove,
			final,
			status: this.status,
			request: this.req,
		};
		if (bm.ponder !== undefined) result.ponder = bm.ponder;
		if (this.req.elo !== undefined) result.engineElo = this.req.elo;
		if (this.atFeatureDepth) result.atFeatureDepth = this.atFeatureDepth;
		this.mailbox.put(final);
		this.mailbox.close();
		this.resolveResult(result);
	}

	fail(): void {
		this.status = "failed";
		this.finish({ bestmove: null });
	}
}

function goArgs(limit: AnalysisRequest["limit"], searchmoves: string[] | undefined): string {
	const parts: string[] = [];
	if (limit.infinite) parts.push("infinite");
	else {
		if (limit.depth !== undefined) parts.push(`depth ${limit.depth}`);
		if (limit.movetimeMs !== undefined) parts.push(`movetime ${limit.movetimeMs}`);
		if (limit.nodes !== undefined) parts.push(`nodes ${limit.nodes}`);
		if (parts.length === 0) parts.push(`movetime ${TIMINGS.analysisDefaultMovetimeMs}`);
	}
	if (searchmoves && searchmoves.length > 0) parts.push(`searchmoves ${searchmoves.join(" ")}`);
	return parts.join(" ");
}

export class UciEngine {
	private st: EngineState = "idle";
	private initialised = false;
	/** A handshake or option burst is in flight: no `position`/`go` until it ends. */
	private busy = false;
	private recovering = false;
	private disposed = false;
	private queue: Pending[] = [];
	private active: Pending | undefined;
	/** Applied options in application order (replayed after a restart). */
	private readonly applied = new Map<string, EngineOptionValue>();
	private waiters: Waiter[] = [];
	private initInfo: EngineInfo = { name: "", author: "", options: {} };
	private stopTimer: unknown;
	private chain: Promise<void> | undefined;
	private readonly unsubscribe: Array<() => void>;
	private readonly sched: UciScheduler;
	private readonly readyTimeoutMs: number;
	private readonly stopTimeoutMs: number;
	private readonly pendingCtx: PendingContext;

	constructor(
		private readonly transport: EngineTransport,
		opts: UciEngineOptions = {}
	) {
		this.sched = opts.scheduler ?? DEFAULT_SCHEDULER;
		this.readyTimeoutMs = opts.readyTimeoutMs ?? TIMINGS.engineReadyTimeoutMs;
		this.stopTimeoutMs = opts.stopTimeoutMs ?? TIMINGS.engineStopTimeoutMs;
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
				for (const [name, value] of Object.entries(options)) this.applied.set(name, value);
				return await this.handshake(true);
			} catch (error) {
				this.st = "crashed";
				this.failQueued();
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
			const changed = Object.entries(opts).filter(
				([name, value]) => value !== undefined && this.applied.get(name) !== value
			);
			if (changed.length === 0) return;
			this.busy = true;
			try {
				for (const [name, value] of changed) this.applyOption(name, value);
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
		const p = new Pending(req, this.pendingCtx);
		if (this.disposed || (this.st === "crashed" && !this.recovering)) {
			p.fail();
			return p.handle();
		}
		const at = this.queue.findIndex((q) => q.rank > p.rank);
		if (at < 0) this.queue.push(p);
		else this.queue.splice(at, 0, p);
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
		this.rejectWaiters(new Error("UciEngine: disposed"));
		const active = this.active;
		this.active = undefined;
		active?.fail();
		this.failQueued();
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
			await this.sendAndWait("uciok", "uci");
			for (const [name, value] of this.applied) this.transport.send(formatSetOption(name, value));
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
			this.failQueued();
			throw err;
		} finally {
			this.busy = false;
			this.pump();
		}
	}

	private isReady(): Promise<void> {
		return this.sendAndWait("readyok", "isready");
	}

	/**
	 * Register a `kind` waiter, then send `line`. The waiter is registered first
	 * so a transport that answers synchronously is not missed; a synchronous
	 * `send` throw removes it again (no dangling timer) and rejects.
	 */
	private sendAndWait(kind: WaitKind, line: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { kind, resolve, reject, timer: undefined };
			waiter.timer = this.sched.setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				reject(new Error(`UciEngine: timed out waiting for ${kind}`));
				this.onCrash(`timeout waiting for ${kind}`);
			}, this.readyTimeoutMs);
			this.waiters.push(waiter);
			try {
				this.transport.send(line);
			} catch (err) {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				this.sched.clearTimeout(waiter.timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private settleWaiters(kind: WaitKind): void {
		const hit = this.waiters.filter((w) => w.kind === kind);
		this.waiters = this.waiters.filter((w) => w.kind !== kind);
		for (const w of hit) {
			this.sched.clearTimeout(w.timer);
			w.resolve();
		}
	}

	private rejectWaiters(err: Error): void {
		const all = this.waiters;
		this.waiters = [];
		for (const w of all) {
			this.sched.clearTimeout(w.timer);
			w.reject(err);
		}
	}

	/** Diffed: sends only when `value` differs from the last applied value; records replay order. */
	private applyOption(name: string, value: EngineOptionValue): void {
		if (this.applied.get(name) === value) return;
		this.applied.delete(name);
		this.applied.set(name, value);
		this.transport.send(formatSetOption(name, value));
	}

	private pump(): void {
		if (this.st !== "idle" || !this.initialised || this.busy || this.active) return;
		const p = this.queue.shift();
		if (!p) return;
		this.active = p;
		this.st = "searching";
		const { fen, moves, multiPv, limit, searchmoves, elo } = p.req;
		if (elo !== undefined) {
			this.applyOption("UCI_LimitStrength", true);
			this.applyOption("UCI_Elo", elo);
		} else if (this.applied.get("UCI_LimitStrength") === true) {
			this.applyOption("UCI_LimitStrength", false);
		}
		this.applyOption("MultiPV", multiPv);
		const suffix = moves && moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
		this.transport.send(`position fen ${fen}${suffix}`);
		this.transport.send(`go ${goArgs(limit, searchmoves)}`);
		let budget: number | undefined;
		if (!limit.infinite && limit.movetimeMs !== undefined)
			budget = limit.movetimeMs + this.stopTimeoutMs;
		else if (limit.infinite && p.priority === "ponder") budget = TIMINGS.ponderMaxMs;
		if (budget !== undefined) {
			p.deadline = this.sched.setTimeout(() => {
				p.deadline = undefined;
				this.stopActive(p, "complete");
			}, budget);
		}
	}

	/** `stop`, then wait for `bestmove` (the stop timeout is the crash path). */
	private stopActive(p: Pending, status: "complete" | "superseded"): void {
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

	private stopRequest(p: Pending): Promise<void> {
		if (p.finished) return Promise.resolve();
		if (this.active === p) {
			this.stopActive(p, "complete");
			return p.done;
		}
		this.queue = this.queue.filter((q) => q !== p);
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
			this.settleWaiters(line);
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
		this.rejectWaiters(new Error(`UciEngine: engine crashed (${reason})`));
		if (this.recovering) return;
		if (wasInitialised) void this.recover();
		else this.failQueued();
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
			this.failQueued();
		} finally {
			this.recovering = false;
		}
	}

	private failQueued(): void {
		const queued = this.queue;
		this.queue = [];
		for (const p of queued) p.fail();
	}
}
