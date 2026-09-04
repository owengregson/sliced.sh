/**
 * Typed registry for `chrome.runtime.onMessage` handlers (Appendix H.1,
 * ported from tranquill's `message-router`).
 *
 * Handlers register against one `MSG.*` type and receive the typed message
 * plus the sender. Every handled message is answered with a
 * `MessageEnvelope`:
 *   - a value or `undefined` → `{ success: true, response }` sent synchronously
 *     (the onMessage listener returns `false`);
 *   - a Promise → awaited, then sent (`true` keeps the channel open);
 *   - a sync throw or rejection → `{ success: false, error }` and a `log.warn`,
 *     so the caller never hangs waiting for a reply.
 * Unhandled or malformed messages return `undefined` and send nothing.
 */

import { onRuntimeMessage } from "@core/chrome/runtime";
import type { MessageType } from "@core/constants/messages";
import { log } from "@core/logger";
import type { MessageEnvelope, MessageResponseMap, TypedMessage } from "./typed-messages";

export type MessageHandler<T extends MessageType> = (
	msg: TypedMessage<T>,
	sender: chrome.runtime.MessageSender
) => MessageResponseMap[T] | Promise<MessageResponseMap[T]> | undefined;

type AnyHandler = (
	msg: TypedMessage,
	sender: chrome.runtime.MessageSender
) => unknown | Promise<unknown>;

export interface MessageRouter {
	/** Register a handler for a message type. Last writer wins (with a warning). */
	on<T extends MessageType>(type: T, handler: MessageHandler<T>): void;
	/** Wire the registry to `chrome.runtime.onMessage` (once). */
	install(): void;
	/** Remove the `onMessage` listener; `install()` may be called again. */
	dispose(): void;
	/**
	 * Drive the dispatcher manually (tests). Resolves with the envelope the
	 * listener would have sent, or returns `undefined` when nothing handles
	 * `message`.
	 */
	_dispatch(
		message: unknown,
		sender: chrome.runtime.MessageSender
	): Promise<MessageEnvelope> | undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || String(error);
	return String(error);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

export function installMessageRouter(): MessageRouter {
	const handlers = new Map<string, AnyHandler>();
	let unsubscribe: (() => void) | null = null;

	function respond(sendResponse: (response: unknown) => void, envelope: MessageEnvelope): void {
		try {
			sendResponse(envelope);
		} catch {
			// ignore — channel may be closed
		}
	}

	function dispatch(
		message: unknown,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void
	): boolean | undefined {
		if (!message || typeof message !== "object") return undefined;
		const msgType = (message as { type?: unknown }).type;
		if (typeof msgType !== "string") return undefined;

		const handler = handlers.get(msgType);
		if (!handler) {
			log.debug("message-router: unhandled message type", { type: msgType });
			return undefined;
		}

		log.debug("message-router: dispatching", { type: msgType, tabId: sender?.tab?.id ?? null });

		let result: unknown;
		try {
			result = handler(message as TypedMessage, sender);
		} catch (error) {
			log.warn("message-router: handler threw", { type: msgType, error });
			respond(sendResponse, { success: false, error: errorMessage(error) });
			return false;
		}

		if (isPromiseLike(result)) {
			result
				.then((value) => respond(sendResponse, { success: true, response: value }))
				.catch((error: unknown) => {
					log.warn("message-router: async handler rejected", { type: msgType, error });
					respond(sendResponse, { success: false, error: errorMessage(error) });
				});
			return true;
		}

		respond(sendResponse, { success: true, response: result });
		return false;
	}

	return {
		on<T extends MessageType>(type: T, handler: MessageHandler<T>): void {
			if (handlers.has(type)) {
				// Silent overwrites mask refactor regressions where the same type is
				// registered twice. Warn loudly but don't throw — startup must not abort.
				log.warn("message-router: handler for type already registered; overwriting", {
					type,
				});
			}
			handlers.set(type, handler as unknown as AnyHandler);
		},
		install(): void {
			if (unsubscribe) return;
			unsubscribe = onRuntimeMessage(dispatch);
		},
		dispose(): void {
			unsubscribe?.();
			unsubscribe = null;
		},
		_dispatch(message, sender) {
			let handled = true;
			const envelope = new Promise<MessageEnvelope>((resolve) => {
				handled = dispatch(message, sender, resolve as (response: unknown) => void) !== undefined;
			});
			return handled ? envelope : undefined;
		},
	};
}
