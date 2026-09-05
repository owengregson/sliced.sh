/**
 * `FeedPort` (Task 21): the content script's `PORT_NAMES.game` connection to
 * the service worker over `connectPort` (reconnect with backoff, ordered
 * queue while disconnected). It remembers the last `hello` and the last
 * `position` it sent; after a disconnect it re-queues both ahead of any
 * later message, so the reconnected service worker learns the site / page
 * kind and the current position first. Every disconnect re-queues them:
 * `connectPort` empties its queue into each new port (as Chrome does, even
 * when that port dies at once), so the queue stays bounded.
 */

import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { connectPort, type PortScheduler } from "@core/messaging/ports";

export interface FeedPort {
	post(msg: GamePortMessage): void;
	/** Resolves once the first connection is established. */
	ready: Promise<void>;
	dispose(): void;
}

export interface FeedPortOptions {
	onCommand: (cmd: GamePortCommand) => void;
	scheduler?: PortScheduler;
}

export function createFeedPort(options: FeedPortOptions): FeedPort {
	let lastHello: GamePortMessage | null = null;
	let lastPosition: GamePortMessage | null = null;

	const port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
		onMessage(cmd) {
			options.onCommand(cmd);
		},
		onDisconnect() {
			if (lastHello) port.post(lastHello);
			if (lastPosition) port.post(lastPosition);
		},
		...(options.scheduler ? { scheduler: options.scheduler } : {}),
	});

	return {
		ready: port.ready,
		post(msg) {
			if (msg.kind === "hello") lastHello = msg;
			else if (msg.kind === "position") lastPosition = msg;
			port.post(msg);
		},
		dispose() {
			port.disconnect();
		},
	};
}
