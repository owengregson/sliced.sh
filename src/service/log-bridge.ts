/**
 * SW-side log bridge (Appendix H.2 / H.3, Task 9 + Task 26).
 *
 * Every log that reaches the service worker — `MSG.LOG` envelopes forwarded by the other
 * contexts and the SW's own `log.*` calls (through the logger's sink) — is printed to the SW
 * console, kept in a bounded ring (`LIMITS.logRingMax`) and fanned out to the panel's log-stream
 * subscribers (`PORT_NAMES.logStream`, accepted by `handlers/log/stream.ts`). Each subscriber
 * carries its own level so the SW filters at the source; the ring itself keeps every level.
 *
 * Fan-out never runs synchronously inside `record`: entries are queued and delivered on a
 * microtask, and anything logged *during* delivery (e.g. `acceptPorts` logging a dead port at
 * debug) goes to the ring only — otherwise logger → sink → send → logger would recurse without
 * bound. A subscriber receives nothing until its `hello` (`sendBacklog`) has been processed; the
 * backlog is then sent from the same flush, after the queued entries, so nothing is duplicated.
 */

import { LIMITS } from "@core/constants/limits";
import { type LogStreamMessage, MSG } from "@core/constants/messages";
import { clearLogSink, type LogEntry, levelAllows, printLog, setLogSink } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import type { LogLevel } from "@typedefs/settings";

/** One connected log-stream subscriber (the port wrapper is owned by `handlers/log/stream.ts`). */
export interface LogSubscriber {
	send(message: LogStreamMessage): void;
	level: LogLevel;
}

export interface LogBridge {
	/** Record an entry: print, ring, fan out (on a microtask). */
	push(entry: LogEntry): void;
	/** The ring, oldest first. */
	backlog(): LogEntry[];
	/** Register a subscriber (streams nothing until `sendBacklog`). Returns the remove. */
	addSubscriber(subscriber: LogSubscriber): () => void;
	/** The subscriber's `hello`: queue its level-filtered backlog, then stream new entries to it. */
	sendBacklog(subscriber: LogSubscriber): void;
	/** Change a subscriber's level; returns whether it changed. */
	setSubscriberLevel(subscriber: LogSubscriber, level: LogLevel): boolean;
	subscriberCount(): number;
	subscriberLevels(): LogLevel[];
	/** Drop the ring, the subscribers and (if still ours) the logger sink. */
	dispose(): void;
}

export function installLogBridge(router: MessageRouter): LogBridge {
	let ring: LogEntry[] = [];
	const subscribers = new Set<LogSubscriber>();
	const ready = new Set<LogSubscriber>();
	const awaitingBacklog = new Set<LogSubscriber>();
	let pending: LogEntry[] = [];
	let flushScheduled = false;
	let flushing = false;
	let disposed = false;

	function safeSend(subscriber: LogSubscriber, message: LogStreamMessage): void {
		try {
			subscriber.send(message);
		} catch {
			// a dead subscriber must not break delivery to the others; its disconnect removes it
		}
	}

	function flush(): void {
		flushScheduled = false;
		if (disposed) return;
		flushing = true;
		try {
			const batch = pending;
			pending = [];
			for (const entry of batch) {
				for (const subscriber of [...subscribers]) {
					if (ready.has(subscriber) && levelAllows(subscriber.level, entry.level))
						safeSend(subscriber, { kind: "entry", entry });
				}
			}
			const hellos = [...awaitingBacklog];
			awaitingBacklog.clear();
			for (const subscriber of hellos) {
				if (!subscribers.has(subscriber)) continue;
				safeSend(subscriber, {
					kind: "backlog",
					entries: ring.filter((e) => levelAllows(subscriber.level, e.level)),
				});
				ready.add(subscriber);
			}
		} finally {
			flushing = false;
		}
	}

	function scheduleFlush(): void {
		if (flushScheduled || disposed) return;
		flushScheduled = true;
		queueMicrotask(flush);
	}

	function record(entry: LogEntry): void {
		ring.push(entry);
		if (ring.length > LIMITS.logRingMax) ring = ring.slice(ring.length - LIMITS.logRingMax);
		// Logged while fanning out (a subscriber's send path): ring only — never re-enter.
		if (flushing) return;
		pending.push(entry);
		scheduleFlush();
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
	const sink = (entry: LogEntry): void => {
		if (!disposed) record(entry);
	};
	setLogSink(sink);

	return {
		push,
		backlog: () => [...ring],
		addSubscriber(subscriber) {
			if (disposed) return () => {};
			subscribers.add(subscriber);
			return () => {
				subscribers.delete(subscriber);
				ready.delete(subscriber);
				awaitingBacklog.delete(subscriber);
			};
		},
		sendBacklog(subscriber) {
			if (disposed || !subscribers.has(subscriber)) return;
			awaitingBacklog.add(subscriber);
			scheduleFlush();
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
			ready.clear();
			awaitingBacklog.clear();
			pending = [];
			ring = [];
			clearLogSink(sink);
		},
	};
}
