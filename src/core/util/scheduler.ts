/**
 * Injectable timer/clock surface shared by modules that own timers
 * (`EngineHost`, `RemoteEngine`); tests pass a fake, production the globals.
 * Compatible with `PortScheduler` (ports) and `UciScheduler` (uci-client).
 */

export interface TimerScheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
}

export const DEFAULT_SCHEDULER: TimerScheduler = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

/**
 * Injectable timer + clock so service modules can be driven by the simulator's
 * virtual time (or a hand-rolled fake) without touching the globals.
 */

export interface Scheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const defaultScheduler: Scheduler = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Epoch ms; the simulator fakes `Date.now` when its clock is installed. */
export const defaultNow = (): number => Date.now();

/** Resolve after `ms` on `scheduler`; resolves early (never rejects) when `signal` aborts. */
export function sleep(ms: number, scheduler: Scheduler, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted || ms <= 0) {
			resolve();
			return;
		}
		const onAbort = (): void => {
			scheduler.clearTimeout(handle);
			resolve();
		};
		const handle = scheduler.setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Thrown by schedule-aware loops when their `AbortSignal` fires. */
export class AbortedError extends Error {
	override readonly name = "AbortError";
	constructor() {
		super("aborted");
	}
}

export function isAbortedError(error: unknown): boolean {
	return error instanceof AbortedError;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AbortedError();
}
