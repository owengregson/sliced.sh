/**
 * SW-side log bridge (Appendix H.2 / H.3, Task 9 + Task 26).
 *
 * Every log that reaches the service worker — `MSG.LOG` envelopes forwarded by the other
 * contexts and the SW's own `log.*` calls (through the logger's sink) — is printed to the SW
 * console, kept in a bounded ring (`LIMITS.logRingMax`) and fanned out to the panel's log-stream
 * subscribers (`PORT_NAMES.logStream`, accepted by `handlers/log/stream.ts`). Each subscriber
 * carries its own level so the SW filters at the source; the ring itself keeps every level.
 */

import { LIMITS } from "@core/constants/limits";
import { type LogStreamMessage, MSG } from "@core/constants/messages";
import { type LogEntry, levelAllows, printLog, setLogSink } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import type { LogLevel } from "@typedefs/settings";

/** One connected log-stream subscriber (the port wrapper is owned by `handlers/log/stream.ts`). */
export interface LogSubscriber {
	send(message: LogStreamMessage): void;
	level: LogLevel;
}

export interface LogBridge {
	/** Record an entry: print, ring, fan out. */
	push(entry: LogEntry): void;
	/** The ring, oldest first. */
	backlog(): LogEntry[];
	/** Register a subscriber; it receives the (level-filtered) backlog at once. Returns the remove. */
	addSubscriber(subscriber: LogSubscriber): () => void;
	/** Change a subscriber's level; returns whether it changed. */
	setSubscriberLevel(subscriber: LogSubscriber, level: LogLevel): boolean;
	subscriberCount(): number;
	subscriberLevels(): LogLevel[];
	/** Drop the ring, the subscribers and the logger sink. */
	dispose(): void;
}

export function installLogBridge(router: MessageRouter): LogBridge {
	let ring: LogEntry[] = [];
	const subscribers = new Set<LogSubscriber>();
	let disposed = false;

	function record(entry: LogEntry): void {
		ring.push(entry);
		if (ring.length > LIMITS.logRingMax) ring = ring.slice(ring.length - LIMITS.logRingMax);
		for (const subscriber of [...subscribers]) {
			if (levelAllows(subscriber.level, entry.level)) subscriber.send({ kind: "entry", entry });
		}
	}

	function push(entry: LogEntry): void {
		printLog(entry);
		if (!disposed) record(entry);
	}

	router.on(MSG.LOG, (msg, sender) => {
		push({
			level: msg.level,
			args: msg.args,
			meta: msg.meta ?? { source: sender.url ?? "unknown", timestamp: Date.now() },
		});
	});

	// The SW's direct `log.*` path (the logger has already printed the entry).
	setLogSink((entry) => {
		if (!disposed) record(entry);
	});

	return {
		push,
		backlog: () => [...ring],
		addSubscriber(subscriber) {
			if (disposed) return () => {};
			subscribers.add(subscriber);
			subscriber.send({
				kind: "backlog",
				entries: ring.filter((e) => levelAllows(subscriber.level, e.level)),
			});
			return () => void subscribers.delete(subscriber);
		},
		setSubscriberLevel(subscriber, level) {
			if (subscriber.level === level) return false;
			subscriber.level = level;
			return true;
		},
		subscriberCount: () => subscribers.size,
		subscriberLevels: () => [...subscribers].map((s) => s.level),
		dispose() {
			if (disposed) return;
			disposed = true;
			subscribers.clear();
			ring = [];
			setLogSink(null);
		},
	};
}
