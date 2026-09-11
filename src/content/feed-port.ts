/**
 * `FeedPort` (Task 21): the content script's `PORT_NAMES.game` connection to
 * the service worker over `connectPort` (reconnect with backoff). It
 * remembers the last `hello`, the last `position` and the last `focus` it sent. While the
 * port is down, outgoing messages wait in this module's own outbox; on
 * every reconnect (`connectPort`'s `onConnect`, which fires before the
 * transport queue is flushed) `hello` and the last `position` go out
 * **first**, then the outbox in order, so the reconnected service worker
 * learns the site / page kind and the current position before anything
 * else.
 *
 * `focus` is remembered for a different reason from the other two. The worker's `FocusGate` holds the
 * page's focus state in memory and has no way to ask for it — there is no focus probe among the game
 * port's commands — and `canExecute` answers `unfocused` while it holds none (§13.4). The content
 * script reports the state once at load (`installFocusEdges`), so on a tab the owner has not blurred
 * since then, a torn-down worker would come back knowing nothing and never be told: every move
 * skipped, nothing to release it. Replaying the last reading closes that, and it is narrow — a newer
 * reading queued during the outage wins.
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
	let lastFocus: GamePortMessage | null = null;
	let down = false;
	let outbox: GamePortMessage[] = [];

	const port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
		onMessage(cmd) {
			options.onCommand(cmd);
		},
		onDisconnect() {
			down = true;
		},
		onConnect() {
			if (!down) return; // first connection: nothing to replay
			down = false;
			const pending = outbox;
			outbox = [];
			if (lastHello) port.post(lastHello);
			if (lastPosition) port.post(lastPosition);
			if (lastFocus && !pending.some((m) => m.kind === "focus")) port.post(lastFocus);
			for (const msg of pending) port.post(msg);
		},
		...(options.scheduler ? { scheduler: options.scheduler } : {}),
	});

	return {
		ready: port.ready,
		post(msg) {
			if (msg.kind === "hello") lastHello = msg;
			else if (msg.kind === "position") lastPosition = msg;
			else if (msg.kind === "focus") lastFocus = msg;
			if (down) outbox.push(msg);
			else port.post(msg);
		},
		dispose() {
			outbox = [];
			port.disconnect();
		},
	};
}
