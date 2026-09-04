// test/fakes/engine-transport.ts
/**
 * Scripted `EngineTransport` for `UciEngine` tests: records every sent line,
 * optionally auto-answers the `uci` / `isready` handshakes on a microtask, and
 * lets a test feed engine output or a crash. Also a deterministic scheduler
 * matching `UciScheduler` so timeouts are driven by `advance()`.
 */

import type { EngineTransport } from "@core/engine/types";
import type { EngineStatus } from "@typedefs/engine";

export const FAKE_ID_LINES = [
	"id name Fake 1",
	"id author sliced",
	"option name Hash type spin default 16 min 1 max 1024",
	"option name MultiPV type spin default 1 min 1 max 256",
	"option name UCI_Elo type spin default 1320 min 1320 max 3190",
	"uciok",
];

export const RESTART_MARKER = "<restart>";

export class FakeEngineTransport implements EngineTransport {
	/** Every line the client sent, plus `RESTART_MARKER` for each `restart()`. */
	readonly sent: string[] = [];
	restarts = 0;
	/** Answer `uci` with `FAKE_ID_LINES` and `isready` with `readyok` on a microtask. */
	autoReply = true;
	/** Overrides `restart()`; the default resolves immediately. */
	restartImpl: (() => Promise<void>) | undefined;
	private readonly lineCbs = new Set<(line: string) => void>();
	private readonly statusCbs = new Set<(s: EngineStatus) => void>();

	send(line: string): void {
		this.sent.push(line);
		if (!this.autoReply) return;
		if (line === "uci") queueMicrotask(() => this.feed(...FAKE_ID_LINES));
		else if (line === "isready") queueMicrotask(() => this.feed("readyok"));
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
		this.restarts++;
		this.sent.push(RESTART_MARKER);
		return this.restartImpl ? this.restartImpl() : Promise.resolve();
	}

	/** Synchronously deliver engine output lines. */
	feed(...lines: string[]): void {
		for (const line of lines) for (const cb of [...this.lineCbs]) cb(line);
	}

	status(state: EngineStatus["state"]): void {
		const s: EngineStatus = { state, variant: "smallnet", threads: 1, nnue: [], version: "fake" };
		for (const cb of [...this.statusCbs]) cb(s);
	}

	crash(): void {
		this.status("crashed");
	}

	/** Lines sent since index `from`. */
	since(from: number): string[] {
		return this.sent.slice(from);
	}
}

interface FakeTimer {
	at: number;
	fn: () => void;
}

export class FakeScheduler {
	now = 0;
	private seq = 0;
	private readonly timers = new Map<number, FakeTimer>();

	setTimeout = (fn: () => void, ms: number): unknown => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.now + ms, fn });
		return id;
	};

	clearTimeout = (handle: unknown): void => {
		if (typeof handle === "number") this.timers.delete(handle);
	};

	nowFn = (): number => this.now;

	get scheduler() {
		return { setTimeout: this.setTimeout, clearTimeout: this.clearTimeout, now: this.nowFn };
	}

	get pending(): number {
		return this.timers.size;
	}

	/** Advance the clock, firing due timers in order. */
	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let nextId: number | undefined;
			let next: FakeTimer | undefined;
			for (const [id, t] of this.timers) {
				if (t.at <= target && (next === undefined || t.at < next.at)) {
					nextId = id;
					next = t;
				}
			}
			if (nextId === undefined || next === undefined) break;
			this.timers.delete(nextId);
			this.now = next.at;
			next.fn();
		}
		this.now = target;
	}
}

/** Let queued microtasks and promise continuations run. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
