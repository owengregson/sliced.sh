/**
 * Panel side of the log stream (Appendix H.2, tranquill's `logging-bridge` pattern): connects
 * `PORT_NAMES.logStream` through `connectPort` (which reconnects with backoff on its own), keeps
 * a local ring of what the service worker sent (`LIMITS.logRingMax`), re-emits every stream
 * message to subscribers and pushes the level to the SW as a port command so filtering happens
 * at the source. The level is re-sent after every disconnect (queued until the port is back), so
 * a restarted SW applies it before its backlog arrives. `dispose()` closes the port.
 */

import { LIMITS } from "@core/constants/limits";
import type { LogStreamCommand, LogStreamMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import type { LogEntry } from "@core/logger";
import { type ConnectedPort, connectPort, type PortScheduler } from "@core/messaging/ports";
import type { LogLevel } from "@typedefs/settings";

export type LogStreamListener = (message: LogStreamMessage) => void;

export interface LoggingBridge {
	readonly level: LogLevel;
	/** Entries received so far (backlog replaced on reconnect, then live entries), oldest first. */
	readonly entries: readonly LogEntry[];
	subscribe(listener: LogStreamListener): () => void;
	/** Local filter + `{ kind: "setLevel" }` to the SW. */
	setLevel(level: LogLevel): void;
	/** Drop the local entries (the SW ring is untouched). */
	clear(): void;
	dispose(): void;
}

export interface LoggingBridgeOptions {
	level: LogLevel;
	scheduler?: PortScheduler;
}

export function createLoggingBridge(options: LoggingBridgeOptions): LoggingBridge {
	let level = options.level;
	let entries: LogEntry[] = [];
	const listeners = new Set<LogStreamListener>();
	let disposed = false;

	function emit(message: LogStreamMessage): void {
		for (const listener of [...listeners]) listener(message);
	}

	function sendLevel(): void {
		port.post({ kind: "setLevel", level });
	}

	const portOptions: Parameters<typeof connectPort<LogStreamCommand, LogStreamMessage>>[1] = {
		onMessage(message) {
			if (disposed || !message || typeof message !== "object") return;
			if (message.kind === "backlog") {
				entries = message.entries.slice(-LIMITS.logRingMax);
				emit(message);
			} else if (message.kind === "entry") {
				entries.push(message.entry);
				if (entries.length > LIMITS.logRingMax)
					entries = entries.slice(entries.length - LIMITS.logRingMax);
				emit(message);
			}
		},
		onDisconnect() {
			// Queued until the port reconnects; the restarted SW applies it before streaming.
			if (!disposed) sendLevel();
		},
	};
	if (options.scheduler) portOptions.scheduler = options.scheduler;
	const port: ConnectedPort<LogStreamCommand> = connectPort<LogStreamCommand, LogStreamMessage>(
		PORT_NAMES.logStream,
		portOptions
	);
	sendLevel();

	return {
		get level() {
			return level;
		},
		get entries() {
			return entries;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		setLevel(next) {
			if (disposed || next === level) return;
			level = next;
			sendLevel();
		},
		clear() {
			entries = [];
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			entries = [];
			port.disconnect();
		},
	};
}
