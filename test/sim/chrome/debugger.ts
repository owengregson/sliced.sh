// test/sim/chrome/debugger.ts
/**
 * `chrome.debugger`: attach/detach bookkeeping per tab with Chrome's error
 * messages, and a `sendCommand` that records EVERY command as a
 * `CdpCommandRecord { tabId, method, params, at }` (`at` = virtual clock at
 * issue time) before answering it. Answers come from, in order: a responder
 * a test scripted with `respond(method, handler)`, the CDP input bridge
 * (`Input.dispatchMouseEvent` → tab DOM), or `{}`.
 *
 * Chrome does not fire `onDetach` for the extension's own `detach()`; the
 * `detachByUser` / `detachTargetClosed` helpers stand in for the infobar
 * "Cancel" button and the tab going away.
 */

import type { Bus } from "@test/sim/contexts/bus";
import { jsonClone } from "@test/sim/contexts/bus";
import type { CdpCommandRecord, CdpResponder, VirtualTab } from "@test/sim/types";

export type CdpSend = (
	tabId: number,
	method: string,
	params: Record<string, unknown> | undefined
) => Promise<unknown>;

export interface DebuggerOptions {
	/** Fallback for commands no responder handles (the CDP input bridge). */
	send?: CdpSend;
	/** Tabs for `getTargets` and the "no tab" attach error. */
	tabs?: () => VirtualTab[];
}

export interface AttachmentRecord {
	tabId: number;
	action: "attach" | "detach";
	at: number;
}

type DetachListener = (
	source: chrome.debugger.Debuggee,
	reason: `${chrome.debugger.DetachReason}`
) => void;
type EventListener = (
	source: chrome.debugger.DebuggerSession,
	method: string,
	params?: object
) => void;

export function createDebuggerSubsystem(bus: Bus, options: DebuggerOptions = {}) {
	const send: CdpSend = options.send ?? (() => Promise.resolve({}));
	const tabs = options.tabs ?? (() => []);
	const attached = new Set<number>();
	const commands: CdpCommandRecord[] = [];
	const attachments: AttachmentRecord[] = [];
	const responders = new Map<string, CdpResponder>();
	const onDetach = bus.event<[chrome.debugger.Debuggee, `${chrome.debugger.DetachReason}`]>();
	const onEvent = bus.event<[chrome.debugger.DebuggerSession, string, object | undefined]>();

	const notAttached = (tabId: number): string =>
		`Debugger is not attached to the tab with id: ${tabId}.`;

	function tabIdOf(target: chrome.debugger.Debuggee): number | null {
		return typeof target.tabId === "number" ? target.tabId : null;
	}

	const api = {
		attach(target: chrome.debugger.Debuggee, _requiredVersion: string, callback?: () => void) {
			const tabId = tabIdOf(target);
			if (tabId === null) return bus.settle(callback, undefined, "Invalid debuggee target.");
			if (options.tabs && !tabs().some((t) => t.id === tabId)) {
				return bus.settle(callback, undefined, `No tab with given id ${tabId}.`);
			}
			if (attached.has(tabId)) {
				return bus.settle(
					callback,
					undefined,
					`Another debugger is already attached to the tab with id: ${tabId}.`
				);
			}
			attached.add(tabId);
			attachments.push({ tabId, action: "attach", at: bus.now() });
			return bus.settle(callback, undefined);
		},
		detach(target: chrome.debugger.Debuggee, callback?: () => void) {
			const tabId = tabIdOf(target);
			if (tabId === null || !attached.has(tabId)) {
				return bus.settle(callback, undefined, notAttached(tabId ?? -1));
			}
			attached.delete(tabId);
			attachments.push({ tabId, action: "detach", at: bus.now() });
			return bus.settle(callback, undefined);
		},
		sendCommand(target: chrome.debugger.Debuggee, method: string, ...rest: unknown[]) {
			// (target, method, params?, cb?) — params may be omitted with the callback in its place.
			const callback = typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1] : undefined;
			const rawParams = typeof rest[0] === "function" ? undefined : rest[0];
			const params =
				rawParams && typeof rawParams === "object"
					? jsonClone(rawParams as Record<string, unknown>)
					: undefined;
			const tabId = tabIdOf(target);
			if (tabId === null || !attached.has(tabId)) {
				return bus.settleAsync(callback, Promise.reject(new Error(notAttached(tabId ?? -1))));
			}
			commands.push({ tabId, method, params, at: bus.now() });
			const responder = responders.get(method);
			const result = responder
				? Promise.resolve().then(() => responder(params, tabId))
				: send(tabId, method, params);
			return bus.settleAsync(callback, result);
		},
		getTargets(callback?: (targets: chrome.debugger.TargetInfo[]) => void) {
			const targets: chrome.debugger.TargetInfo[] = tabs().map((t) => ({
				type: "page",
				id: `target-${t.id}`,
				tabId: t.id,
				attached: attached.has(t.id),
				title: t.title,
				url: t.url,
			}));
			return bus.settle(callback, targets);
		},
		onDetach: {
			addListener: (l: DetachListener) => onDetach.addListener(l),
			removeListener: (l: DetachListener) => onDetach.removeListener(l),
			hasListener: (l: DetachListener) => onDetach.hasListener(l),
		},
		onEvent: {
			addListener: (l: EventListener) => onEvent.addListener(l),
			removeListener: (l: EventListener) => onEvent.removeListener(l),
			hasListener: (l: EventListener) => onEvent.hasListener(l),
		},
	};

	function forceDetach(tabId: number, reason: `${chrome.debugger.DetachReason}`): void {
		if (!attached.has(tabId)) return;
		attached.delete(tabId);
		attachments.push({ tabId, action: "detach", at: bus.now() });
		onDetach.fire({ tabId }, reason);
	}

	return {
		api,
		/** Every `sendCommand`, in order, with virtual-clock timestamps. */
		commands,
		/** Every attach/detach transition, in order. */
		attachments,
		commandsFor: (method: string): CdpCommandRecord[] => commands.filter((c) => c.method === method),
		clearCommands(): void {
			commands.length = 0;
		},
		isAttached: (tabId: number): boolean => attached.has(tabId),
		attachedTabs: (): number[] => [...attached],
		/** Script the answer for a CDP method (e.g. `Runtime.evaluate`); returns the un-hook. */
		respond(method: string, handler: CdpResponder): () => void {
			responders.set(method, handler);
			return () => {
				if (responders.get(method) === handler) responders.delete(method);
			};
		},
		/** The user clicked "Cancel" on the debugging infobar. */
		detachByUser(tabId: number): void {
			forceDetach(tabId, "canceled_by_user");
		},
		/** The tab was closed / navigated away while attached. */
		detachTargetClosed(tabId: number): void {
			forceDetach(tabId, "target_closed");
		},
		/** Deliver a CDP event (e.g. `Runtime.consoleAPICalled`) to `onEvent` listeners. */
		emitEvent(tabId: number, method: string, params?: object): void {
			onEvent.fire({ tabId }, method, params);
		},
	};
}

export type DebuggerSubsystem = ReturnType<typeof createDebuggerSubsystem>;
