/**
 * Typed request/response messaging over `chrome.runtime.sendMessage` /
 * `chrome.tabs.sendMessage` (§4.3).
 *
 * `MessagePayloadMap` and `MessageResponseMap` are keyed by the `MSG.*` values
 * so `sendTyped({ type, ...payload })` infers its return type. Every reply on
 * the wire is a `MessageEnvelope` produced by the router (`router.ts`):
 * `{ success: true, response }` or `{ success: false, error }`; the senders
 * here unwrap it and throw `Error(error)` on failure.
 */

// biome-ignore-all lint/suspicious/noConfusingVoidType: `void` marks fire-and-forget responses (ruling)

import { runtimeSendMessage } from "@core/chrome/runtime";
import { tabsSendMessage } from "@core/chrome/tabs";
import { type MessageType, MSG, type PanelSnapshot } from "@core/constants/messages";
import type { LogSeverity } from "@core/logger";
import type { SerializedValue } from "@core/serialization";
import type { EngineStatus } from "@typedefs/engine";
import type { HighlightStyle, Square } from "@typedefs/game";
import type { Keybinds, LicenseState } from "@typedefs/settings";
import type { TimingLogEntry } from "@typedefs/timing";

/**
 * Payload of a message without fields. (`Record<string, never>` would make
 * `type` itself `never` once intersected with `{ type: T }`.)
 */
export type EmptyPayload = Record<never, never>;

/** Request payloads (everything on the message besides `type`). */
export interface MessagePayloadMap {
	// panel → SW
	/** `windowId`: the panel's window once known (see `PanelPortCommand`); else the last-focused one. */
	[MSG.PANEL_GET_SNAPSHOT]: { windowId?: number };
	[MSG.PANEL_PLAY_NOW]: { tabId: number };
	[MSG.PANEL_SET_AUTO_MOVE]: { tabId: number; armed: boolean };
	[MSG.PANEL_CANCEL_PENDING]: { tabId: number };
	[MSG.PANEL_SET_ENABLED]: { enabled: boolean };
	[MSG.PANEL_PREVIEW_LINE]: { tabId: number; multipv: number | null };
	[MSG.PANEL_LOGIN]: { key: string };
	[MSG.PANEL_LOGOUT]: EmptyPayload;
	[MSG.PANEL_RECHECK_LICENSE]: EmptyPayload;
	[MSG.PANEL_ENGINE_RESTART]: EmptyPayload;
	[MSG.PANEL_EXPORT_TIMING_LOG]: EmptyPayload;
	// Task 26
	[MSG.PANEL_CLEAR_TIMING_LOG]: EmptyPayload;
	[MSG.PANEL_RESET_SESSION]: EmptyPayload;
	[MSG.PANEL_DETACH_DEBUGGER]: { tabId: number };
	[MSG.PANEL_REATTACH_DEBUGGER]: { tabId: number };
	// content → SW
	[MSG.CONTENT_HELLO]: EmptyPayload;
	[MSG.CONTENT_KEYBIND]: { action: keyof Keybinds };
	// SW → content
	[MSG.CONTENT_HIGHLIGHT]: { from: Square; to: Square; style: HighlightStyle };
	[MSG.CONTENT_CLEAR_HIGHLIGHT]: EmptyPayload;
	[MSG.CONTENT_SET_KEYBINDS]: { keybinds: Keybinds };
	[MSG.CONTENT_START_NEW_GAME]: EmptyPayload;
	// offscreen ↔ SW
	[MSG.OFFSCREEN_PING]: EmptyPayload;
	[MSG.OFFSCREEN_ENGINE_STATUS]: EmptyPayload;
	// shared (the logger's `LogEnvelope` is assignable to this)
	[MSG.LOG]: {
		level: LogSeverity;
		args: SerializedValue[];
		meta?: { source: string; timestamp: number };
	};
}

/** Response value carried inside the envelope for each request type (`void` = fire-and-forget). */
export interface MessageResponseMap {
	[MSG.PANEL_GET_SNAPSHOT]: PanelSnapshot;
	[MSG.PANEL_PLAY_NOW]: void;
	[MSG.PANEL_SET_AUTO_MOVE]: void;
	[MSG.PANEL_CANCEL_PENDING]: void;
	[MSG.PANEL_SET_ENABLED]: void;
	[MSG.PANEL_PREVIEW_LINE]: void;
	[MSG.PANEL_LOGIN]: LicenseState;
	[MSG.PANEL_LOGOUT]: LicenseState;
	[MSG.PANEL_RECHECK_LICENSE]: LicenseState;
	[MSG.PANEL_ENGINE_RESTART]: void;
	[MSG.PANEL_EXPORT_TIMING_LOG]: TimingLogEntry[];
	// Task 26
	[MSG.PANEL_CLEAR_TIMING_LOG]: void;
	[MSG.PANEL_RESET_SESSION]: void;
	[MSG.PANEL_DETACH_DEBUGGER]: void;
	[MSG.PANEL_REATTACH_DEBUGGER]: void;
	[MSG.CONTENT_HELLO]: { keybinds: Keybinds; enabled: boolean };
	[MSG.CONTENT_KEYBIND]: void;
	[MSG.CONTENT_HIGHLIGHT]: void;
	[MSG.CONTENT_CLEAR_HIGHLIGHT]: void;
	[MSG.CONTENT_SET_KEYBINDS]: void;
	[MSG.CONTENT_START_NEW_GAME]: void;
	[MSG.OFFSCREEN_PING]: { ok: true };
	[MSG.OFFSCREEN_ENGINE_STATUS]: EngineStatus;
	[MSG.LOG]: void;
}

// Compile-time check: both maps cover exactly the `MSG` values (no more, no fewer).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type _PayloadMapComplete = AssertTrue<Exact<keyof MessagePayloadMap, MessageType>>;
type _ResponseMapComplete = AssertTrue<Exact<keyof MessageResponseMap, MessageType>>;

export type TypedMessage<T extends MessageType = MessageType> = { type: T } & MessagePayloadMap[T];

/** Any message the router accepts. */
export type AnyTypedMessage = { [T in MessageType]: TypedMessage<T> }[MessageType];

/** Wire reply produced by the router for every handled message. */
export type MessageEnvelope<R = unknown> =
	| { success: true; response: R }
	| { success: false; error: string };

export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { success?: unknown }).success === "boolean"
	);
}

/** Resolve an envelope to its response, throwing `Error(error)` on failure. */
export function unwrapEnvelope<R>(value: unknown, context: string): R {
	if (!isMessageEnvelope(value)) {
		throw new Error(`${context}: no response (no handler registered or channel closed)`);
	}
	if (!value.success) throw new Error(value.error);
	return value.response as R;
}

/** Send to the extension runtime (SW, or from the SW to extension pages). */
export async function sendTyped<T extends MessageType>(
	msg: TypedMessage<T>
): Promise<MessageResponseMap[T]> {
	const reply = await runtimeSendMessage<unknown>(msg);
	return unwrapEnvelope<MessageResponseMap[T]>(reply, msg.type);
}

/**
 * Send to the content script in `tabId`. The tabs wrapper's own
 * `{ success, response?, error? }` result is resolved first (missing content
 * script → throws), then the router envelope inside it.
 */
export async function sendTypedToTab<T extends MessageType>(
	tabId: number,
	msg: TypedMessage<T>
): Promise<MessageResponseMap[T]> {
	const result = await tabsSendMessage(tabId, msg);
	if (!result.success) throw new Error(result.error ?? `${msg.type}: tab ${tabId} unreachable`);
	return unwrapEnvelope<MessageResponseMap[T]>(result.response, msg.type);
}
