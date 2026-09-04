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
