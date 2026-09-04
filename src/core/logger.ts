/**
 * Cross-context logger (Appendix H.3, adapted). The service worker prints
 * directly; every other context forwards a `MSG.LOG` envelope to the SW via
 * `runtimeSendMessage` (failures are swallowed) so nothing reaches the host
 * page or panel console. The level follows `Settings.advanced.logLevel`.
 *
 * This is the only file under `src/` allowed to call `console.*` (biome override).
 */

import { runtimeSendMessage } from "@core/chrome/runtime";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MSG } from "@core/constants/messages";
import { type SerializedValue, toSerializable } from "@core/serialization";
import type { LogLevel } from "@typedefs/settings";

export type LogSeverity = Exclude<LogLevel, "silent">;

export interface LogEntry {
	level: LogSeverity;
	args: SerializedValue[];
	meta: { source: string; timestamp: number };
}

/** Wire shape of a forwarded log (`type` is `MSG.LOG`). */
export interface LogEnvelope extends LogEntry {
	type: typeof MSG.LOG;
}

export const LOG_PREFIX = "[sliced]";

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let currentLevel: LogLevel = DEFAULT_SETTINGS.advanced.logLevel;

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

export function getLogLevel(): LogLevel {
	return currentLevel;
}

function enabled(level: LogSeverity): boolean {
	return RANK[level] <= RANK[currentLevel];
}

const isServiceWorker =
	typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope;

function detectSource(): string {
	if (isServiceWorker) return "service-worker";
	try {
		const href = globalThis.location?.href;
		if (typeof href === "string") return href;
	} catch {
		// no location in this context
	}
	return "unknown";
}

/** Print an entry to this context's console (the SW calls this for forwarded logs too). */
export function printLog(entry: LogEntry): void {
	if (!enabled(entry.level)) return;
	const tag = entry.meta.source === "service-worker" ? [] : [`(${entry.meta.source})`];
	console[entry.level](LOG_PREFIX, ...tag, ...entry.args);
}

function isSeverity(level: unknown): level is LogSeverity {
	return typeof level === "string" && level !== "silent" && Object.hasOwn(RANK, level);
}

export function isLogEnvelope(message: unknown): message is LogEnvelope {
	if (typeof message !== "object" || message === null) return false;
	const m = message as { type?: unknown; args?: unknown; level?: unknown; meta?: unknown };
	return (
		m.type === MSG.LOG &&
		Array.isArray(m.args) &&
		isSeverity(m.level) &&
		typeof m.meta === "object" &&
		m.meta !== null
	);
}

function emit(level: LogSeverity, values: unknown[]): void {
	if (!enabled(level)) return;
	const entry: LogEntry = {
		level,
		args: values.map((v) => toSerializable(v)),
		meta: { source: detectSource(), timestamp: Date.now() },
	};
	if (isServiceWorker) {
		printLog(entry);
		return;
	}
	const envelope: LogEnvelope = { type: MSG.LOG, ...entry };
	runtimeSendMessage(envelope).catch(() => {
		// no receiver (SW asleep, test stub, or detached context) — drop silently
	});
}

export const log = {
	debug: (...values: unknown[]): void => emit("debug", values),
	info: (...values: unknown[]): void => emit("info", values),
	warn: (...values: unknown[]): void => emit("warn", values),
	error: (...values: unknown[]): void => emit("error", values),
};
