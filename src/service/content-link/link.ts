/** The `ContentLink` (see `@service/content-link`). */

import { CONTENT_LINK_ERRORS, POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { log } from "@core/logger";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import { AbortedError, defaultNow, defaultScheduler } from "@core/util/scheduler";
import { PendingRequests } from "@service/content-link/pending-requests";
import { PointerState } from "@service/content-link/pointer-state";
import type {
	AnyMessageListener,
	ContentLinkEvents,
	ContentLinkOptions,
	ReplyFor,
	RequestInput,
	RequestKind,
	TabMessageListener,
} from "@service/content-link/types";

interface Entry {
	port: AcceptedPort<GamePortCommand, GamePortMessage>;
	windowId: number | null;
	offs: Array<() => void>;
}

export class ContentLink implements ContentLinkEvents {
	private readonly pointers = new PointerState();
	private readonly ports = new Map<number, Entry>();
	private readonly requests: PendingRequests;
	private readonly listeners = new Set<AnyMessageListener>();
	private readonly connectListeners = new Set<(tabId: number) => void>();
	private readonly disconnectListeners = new Set<(tabId: number, reason?: string) => void>();
	private readonly now: () => number;
	private stop: () => void;
	private disposed = false;

	constructor(options: ContentLinkOptions = {}) {
		this.requests = new PendingRequests(options.scheduler ?? defaultScheduler);
		this.now = options.now ?? defaultNow;
		this.stop = acceptPorts<GamePortCommand, GamePortMessage>(PORT_NAMES.game, (port) =>
			this.accept(port)
		);
	}

	tabs(): number[] {
		return [...this.ports.keys()];
	}

	isConnected(tabId: number): boolean {
		return this.ports.has(tabId);
	}

	windowIdOf(tabId: number): number | null {
		return this.ports.get(tabId)?.windowId ?? null;
	}

	/** Fire-and-forget; `false` when the tab has no live port. */
	post(tabId: number, cmd: GamePortCommand): boolean {
		const entry = this.ports.get(tabId);
		if (!entry) return false;
		this.pointers.note(tabId, cmd);
		entry.port.post(cmd);
		return true;
	}

	/** Cleanup from an older gesture must not hide a newer owner's cursor. */
	pointerVersion(tabId: number): number {
		return this.pointers.version(tabId);
	}

	/**
	 * Whether the mirror has been drawn on this tab and not hidden since (a `cursorTo` went out
	 * after the last `cursorHide`, on this port). While it is, the arrow is the pointer the owner
	 * sees, so the hand starts from where it is parked rather than from a real pointer sample.
	 */
	pointerControlled(tabId: number): boolean {
		return this.pointers.isControlled(tabId);
	}

	/** Install the page's single-use admission before sending the matching browser event. */
	async preparePointer(
		tabId: number,
		pointer: PreparedPointer,
		signal?: AbortSignal
	): Promise<number | undefined> {
		if (!this.pointers.isControlled(tabId)) return undefined;
		const reply = await this.request(
			tabId,
			{ kind: "cursorPrepare", pointer },
			POINTER_CONTROL.prepareTimeoutMs,
			signal
		);
		if (reply.kind !== "cursorPrepared") throw new Error(CONTENT_LINK_ERRORS.disconnected);
		return pointer.timestampMs;
	}

	/** A renderer acknowledgment alone cannot prove that the page input filter accepted the press. */
	async confirmPointer(tabId: number, pointer: PreparedPointer): Promise<boolean> {
		if (!this.pointers.isControlled(tabId)) return true;
		const reply = await this.request(
			tabId,
			{ kind: "cursorDelivery", pointer },
			POINTER_CONTROL.prepareTimeoutMs
		);
		return reply.kind === "cursorDelivered" && reply.delivered;
	}

	/**
	 * Send a request and resolve with the reply carrying the same `id`. An
	 * abort on `signal` rejects at once with `AbortedError` (the pending entry
	 * and its timer are dropped; a late reply is ignored).
	 */
	request<K extends RequestKind>(
		tabId: number,
		cmd: RequestInput<K>,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<ReplyFor<K>> {
		const entry = this.ports.get(tabId);
		if (!entry) return Promise.reject(new Error(CONTENT_LINK_ERRORS.noPort));
		if (signal?.aborted) return Promise.reject(new AbortedError());
		return this.requests.open<ReplyFor<K>>(tabId, cmd.kind, timeoutMs, signal, (id) => {
			const wire = { ...cmd, id, timeoutMs: cmd.timeoutMs ?? timeoutMs } as unknown as GamePortCommand;
			entry.port.post(wire);
		});
	}

	onMessage(tabId: "*", cb: AnyMessageListener): () => void;
	onMessage(tabId: number, cb: TabMessageListener): () => void;
	onMessage(tabId: number | "*", cb: AnyMessageListener | TabMessageListener): () => void {
		const listener: AnyMessageListener =
			tabId === "*"
				? (cb as AnyMessageListener)
				: (id, msg) => {
						if (id === tabId) (cb as TabMessageListener)(msg);
					};
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	onConnect(cb: (tabId: number) => void): () => void {
		this.connectListeners.add(cb);
		return () => void this.connectListeners.delete(cb);
	}

	onDisconnect(cb: (tabId: number, reason?: string) => void): () => void {
		this.disconnectListeners.add(cb);
		return () => void this.disconnectListeners.delete(cb);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
		this.stop = () => {};
		for (const entry of this.ports.values()) for (const off of entry.offs) off();
		this.ports.clear();
		this.pointers.clear();
		this.requests.fail(null, CONTENT_LINK_ERRORS.disposed);
		this.listeners.clear();
		this.connectListeners.clear();
		this.disconnectListeners.clear();
	}

	private accept(port: AcceptedPort<GamePortCommand, GamePortMessage>): void {
		const tabId = port.sender?.tab?.id;
		if (typeof tabId !== "number") {
			log.debug("content-link: game port without a tab sender ignored");
			return;
		}
		const previous = this.ports.get(tabId);
		if (previous) this.drop(tabId, previous, "replaced");
		const entry: Entry = { port, windowId: port.sender?.tab?.windowId ?? null, offs: [] };
		entry.offs.push(port.onMessage((msg) => this.receive(tabId, msg)));
		entry.offs.push(port.onDisconnect((reason) => this.drop(tabId, entry, reason)));
		this.ports.set(tabId, entry);
		log.debug("content-link: port connected", { tabId, at: this.now() });
		for (const cb of [...this.connectListeners]) cb(tabId);
	}

	private receive(tabId: number, msg: GamePortMessage): void {
		if (this.requests.resolve(tabId, msg)) return;
		for (const l of [...this.listeners]) l(tabId, msg);
	}

	private drop(tabId: number, entry: Entry, reason: string | undefined): void {
		if (this.ports.get(tabId) !== entry) return;
		for (const off of entry.offs) off();
		this.ports.delete(tabId);
		this.pointers.forget(tabId);
		this.requests.fail(tabId, CONTENT_LINK_ERRORS.disconnected);
		log.debug("content-link: port disconnected", { tabId, reason: reason ?? null });
		for (const cb of [...this.disconnectListeners]) cb(tabId, reason);
	}
}
