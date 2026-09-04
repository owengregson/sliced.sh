// test/sim/time/time-controller.ts
/**
 * Virtual clock for the simulator.
 *
 *   - `now()` is ms since the epoch (starts at `SimulatorOptions.startAt`);
 *     it only moves through `advance` / `setNow`, never on its own.
 *   - `install()` replaces `setTimeout`, `clearTimeout`, `setInterval`,
 *     `clearInterval`, `Date.now` and `performance.now` with fakes bound to
 *     this clock for the rest of the test; `uninstall()` restores them.
 *   - `advance(ms)` walks the clock to `now + ms`, firing fake timers and
 *     registered sources (alarms) strictly in due-time order (ties: creation
 *     order, timers before alarms) and draining microtasks after each one,
 *     so `await sleep(...)` chains progress like they would in Chrome.
 *   - `flush()` runs everything already due and drains microtasks.
 */

import type { TimerSource } from "@test/sim/types";

export interface AdvanceUntilIdleOptions {
	/** Cap how far the clock may advance in one call (default 5 minutes). */
	maxAdvanceMs?: number;
}

interface FakeTimer {
	id: number;
	due: number;
	seq: number;
	fn: (...args: unknown[]) => void;
	args: unknown[];
	interval: number | null;
	/** Context that armed the timer (from `ContextHook.capture`). */
	owner: string;
}

/** Lets timers fire in the context that armed them (wired to the bus by `createSimulator`). */
export interface ContextHook {
	capture(): string;
	run<T>(owner: string, fn: () => T): T;
}

export interface TimeController {
	now(): number;
	/** ms since the clock's origin — what `performance.now()` returns while installed. */
	performanceNow(): number;
	setNow(epochMs: number): void;
	advance(ms: number): Promise<void>;
	flush(): Promise<void>;
	advanceUntilIdle(options?: AdvanceUntilIdleOptions): Promise<void>;
	/** Drain the microtask queue (a real macrotask hop; fake timers do not run). */
	runMicrotasks(): Promise<void>;
	addSource(source: TimerSource): () => void;
	install(): void;
	uninstall(): void;
	readonly installed: boolean;
	/** Fake timers currently armed (0 when not installed). */
	pendingTimers(): number;
	/** Earliest due time across timers and sources, or `null`. */
	nextDue(): number | null;
	setContextHook(hook: ContextHook): void;
}

const MAX_STEPS = 100_000;

export function createTimeController(startAt: number): TimeController {
	const origin = startAt;
	let currentNow = startAt;
	let installed = false;
	const sources = new Set<TimerSource>();
	const timers = new Map<number, FakeTimer>();
	let nextTimerId = 1;
	let seq = 0;
	let hook: ContextHook = { capture: () => "", run: (_owner, fn) => fn() };

	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const realDateNow = Date.now;
	const realPerformanceNow = globalThis.performance.now;
	const realSetImmediate =
		typeof globalThis.setImmediate === "function"
			? globalThis.setImmediate
			: (fn: () => void): unknown => realSetTimeout(fn, 0);

	const runMicrotasks = (): Promise<void> =>
		new Promise<void>((resolve) => {
			realSetImmediate(() => resolve());
		});

	function armTimer(fn: unknown, ms: unknown, args: unknown[], interval: boolean): number {
		const id = nextTimerId++;
		const delay = Math.max(0, Number(ms) || 0);
		const callback = typeof fn === "function" ? (fn as (...a: unknown[]) => void) : () => {};
		timers.set(id, {
			id,
			due: currentNow + delay,
			seq: seq++,
			fn: callback,
			args,
			interval: interval ? Math.max(1, delay) : null,
			owner: hook.capture(),
		});
		return id;
	}

	const timerIdOf = (handle: unknown): number | null => {
		if (typeof handle === "number") return handle;
		if (handle && typeof handle === "object" && "id" in handle) return Number(handle.id);
		return null;
	};

	function earliestTimer(): FakeTimer | null {
		let best: FakeTimer | null = null;
		for (const t of timers.values()) {
			if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
		}
		return best;
	}

	function earliestSource(): { source: TimerSource; due: number } | null {
		let best: { source: TimerSource; due: number } | null = null;
		for (const source of sources) {
			const due = source.nextDue();
			if (due !== null && (!best || due < best.due)) best = { source, due };
		}
		return best;
	}

	function nextDue(): number | null {
		const t = earliestTimer();
		const s = earliestSource();
		if (!t && !s) return null;
		if (!t) return s?.due ?? null;
		if (!s) return t.due;
		return Math.min(t.due, s.due);
	}

	function runTimer(timer: FakeTimer): void {
		if (timer.interval === null) timers.delete(timer.id);
		else {
			timer.due += timer.interval;
			timer.seq = seq++;
		}
		hook.run(timer.owner, () => timer.fn(...timer.args));
	}

	/** Fire the single earliest item due at or before `limit`; returns false when nothing is due. */
	function step(limit: number): boolean {
		const t = earliestTimer();
		const s = earliestSource();
		const tDue = t ? t.due : Number.POSITIVE_INFINITY;
		const sDue = s ? s.due : Number.POSITIVE_INFINITY;
		const due = Math.min(tDue, sDue);
		if (due === Number.POSITIVE_INFINITY || due > limit) return false;
		if (due > currentNow) currentNow = due;
		if (t && tDue <= sDue) runTimer(t);
		else if (s) s.source.fireDue(currentNow);
		return true;
	}

	async function advance(ms: number): Promise<void> {
		if (!(ms >= 0)) throw new Error("time.advance(ms): ms must be >= 0");
		const target = currentNow + ms;
		let steps = 0;
		const guard = (): void => {
			if (++steps > MAX_STEPS) throw new Error("time.advance: too many timer steps (runaway loop?)");
		};
		// Drain first: a continuation may still have to arm the timer we are about to look for.
		await runMicrotasks();
		while (step(target)) {
			await runMicrotasks();
			guard();
		}
		currentNow = target;
		await runMicrotasks();
		while (step(target)) {
			await runMicrotasks();
			guard();
		}
	}

	async function flush(): Promise<void> {
		let steps = 0;
		await runMicrotasks();
		while (step(currentNow)) {
			await runMicrotasks();
			if (++steps > MAX_STEPS) throw new Error("time.flush: too many timer steps (runaway loop?)");
		}
	}

	async function advanceUntilIdle(options: AdvanceUntilIdleOptions = {}): Promise<void> {
		const limit = currentNow + (options.maxAdvanceMs ?? 5 * 60_000);
		let steps = 0;
		for (;;) {
			await runMicrotasks();
			const due = nextDue();
			if (due === null || due > limit) return;
			await advance(Math.max(0, due - currentNow));
			if (++steps > MAX_STEPS) throw new Error("time.advanceUntilIdle: runaway loop");
		}
	}

	function install(): void {
		if (installed) return;
		installed = true;
		const g = globalThis as unknown as Record<string, unknown>;
		g.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => armTimer(fn, ms, args, false);
		g.clearTimeout = (handle: unknown) => {
			const id = timerIdOf(handle);
			if (id !== null) timers.delete(id);
		};
		g.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => armTimer(fn, ms, args, true);
		g.clearInterval = g.clearTimeout;
		Date.now = () => currentNow;
		globalThis.performance.now = () => currentNow - origin;
	}

	function uninstall(): void {
		if (!installed) return;
		installed = false;
		const g = globalThis as unknown as Record<string, unknown>;
		g.setTimeout = realSetTimeout;
		g.clearTimeout = realClearTimeout;
		g.setInterval = realSetInterval;
		g.clearInterval = realClearInterval;
		Date.now = realDateNow;
		globalThis.performance.now = realPerformanceNow;
		timers.clear();
	}

	return {
		now: () => currentNow,
		performanceNow: () => currentNow - origin,
		setNow(epochMs) {
			currentNow = epochMs;
		},
		advance,
		flush,
		advanceUntilIdle,
		runMicrotasks,
		addSource(source) {
			sources.add(source);
			return () => void sources.delete(source);
		},
		install,
		uninstall,
		get installed() {
			return installed;
		},
		pendingTimers: () => timers.size,
		nextDue,
		setContextHook(next) {
			hook = next;
		},
	};
}
