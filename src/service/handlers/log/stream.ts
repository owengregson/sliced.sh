/**
 * `PORT_NAMES.logStream` acceptance (Appendix H.2): each panel connection becomes a bridge
 * subscriber; its first `{ kind: "hello", level }` sets the level and triggers the backlog (so
 * the backlog is filtered by the panel's level, not the SW's), then every new entry at or above
 * the level streams. `{ kind: "setLevel" }` moves the filter at the source. Returns the
 * unsubscribe that stops accepting new connections (open ports stream until they disconnect).
 */

import type { LogStreamCommand, LogStreamMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { getLogLevel, isLogLevel, log } from "@core/logger";
import { acceptPorts } from "@core/messaging/ports";
import type { LogBridge, LogSubscriber } from "@service/log-bridge";

export function registerLogStreamPort(bridge: LogBridge): () => void {
	return acceptPorts<LogStreamMessage, LogStreamCommand>(PORT_NAMES.logStream, (port) => {
		const subscriber: LogSubscriber = { send: (m) => port.post(m), level: getLogLevel() };
		const remove = bridge.addSubscriber(subscriber);
		const offMessage = port.onMessage((msg) => {
			if (!msg || typeof msg !== "object") return;
			if (msg.kind === "hello" && isLogLevel(msg.level)) {
				bridge.setSubscriberLevel(subscriber, msg.level);
				bridge.sendBacklog(subscriber);
				return;
			}
			if (msg.kind === "setLevel" && isLogLevel(msg.level)) {
				if (bridge.setSubscriberLevel(subscriber, msg.level))
					log.debug("log-stream: subscriber level set", { level: msg.level });
				return;
			}
			log.debug("log-stream: unknown port command", { kind: (msg as { kind?: unknown }).kind });
		});
		const offDisconnect = port.onDisconnect(() => {
			remove();
			offMessage();
			offDisconnect();
		});
	});
}
