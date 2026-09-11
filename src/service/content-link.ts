/**
 * SW-side registry of the per-tab game ports (`PORT_NAMES.game`, one per
 * content script). Accepts every connection, keys it by the sender's tab,
 * fans incoming `GamePortMessage`s out to per-tab / global subscribers, and
 * runs request/reply pairs correlated by `id` (`geometry`, `observeMove`,
 * `boardCheck`)
 * with a timeout on the injected scheduler. The executor's verifier and the
 * `FocusGate` / `HandOwnership` consume it; Task 30's content handlers build
 * on the same object, so nothing here is executor-specific.
 */

import { CONTENT_LINK_ERRORS, POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { log } from "@core/logger";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import { errorMessage } from "@core/util/errors";
import { AbortedError, defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";

export type RequestCommand = Extract<GamePortCommand, { id: string }>;
export type RequestKind = RequestCommand["kind"];
type ReplyKindOf<K extends RequestKind> = K extends "geometry"
	? "geometryResult"
	: K extends "observeMove"
		? "observeMoveResult"
		: K extends "boardCheck"
			? "boardCheckResult"
			: K extends "cursorProbe"
				? "cursorProbeResult"
				: K extends "cursorPrepare"
					? "cursorPrepared"
					: K extends "cursorDelivery"
						? "cursorDelivered"
						: never;
export type ReplyFor<K extends RequestKind> = Extract<GamePortMessage, { kind: ReplyKindOf<K> }>;
/** A request without its `id`; `timeoutMs` defaults to the request budget. */
export type RequestInput<K extends RequestKind> = { kind: K } & Omit<
	Extract<RequestCommand, { kind: K }>,
	"id" | "kind" | "timeoutMs"
> & { timeoutMs?: number };

export type TabMessageListener = (msg: GamePortMessage) => void;
export type AnyMessageListener = (tabId: number, msg: GamePortMessage) => void;

/** The read-only event surface (what the focus gate and hand ownership need). */
export interface ContentLinkEvents {
	onMessage(tabId: "*", cb: AnyMessageListener): () => void;
	onMessage(tabId: number, cb: TabMessageListener): () => void;
	onDisconnect(cb: (tabId: number, reason?: string) => void): () => void;
	windowIdOf(tabId: number): number | null;
}

export interface ContentLinkOptions {
	scheduler?: Scheduler;
	now?: () => number;
}

interface Entry {
	port: AcceptedPort<GamePortCommand, GamePortMessage>;
	windowId: number | null;
	offs: Array<() => void>;
}

interface Pending {
	tabId: number;
	resolve: (msg: GamePortMessage) => void;
	reject: (error: Error) => void;
	timer: unknown;
}

export class ContentLink implements ContentLinkEvents {
	private readonly controlledPointers = new Set<number>();
	private readonly ports = new Map<number, Entry>();
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<AnyMessageListener>();
	private readonly connectListeners = new Set<(tabId: number) => void>();
	private readonly disconnectListeners = new Set<(tabId: number, reason?: string) => void>();
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private stop: () => void;
	private seq = 0;
	private disposed = false;

	constructor(options: ContentLinkOptions = {}) {
		this.scheduler = options.scheduler ?? defaultScheduler;
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
		if (cmd.kind === "cursorTo") this.controlledPointers.add(tabId);
		else if (cmd.kind === "cursorHide") this.controlledPointers.delete(tabId);
		entry.port.post(cmd);
		return true;
	}

	/** Install the page's single-use admission before sending the matching browser event. */
	async preparePointer(
		tabId: number,
		pointer: PreparedPointer,
		signal?: AbortSignal
	): Promise<number | undefined> {
		if (!this.controlledPointers.has(tabId)) return undefined;
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
		if (!this.controlledPointers.has(tabId)) return true;
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
		this.seq += 1;
		const id = `r${this.seq}`;
		return new Promise<ReplyFor<K>>((resolve, reject) => {
			const settle = (): void => {
				this.pending.delete(id);
				this.scheduler.clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = (): void => {
				settle();
				reject(new AbortedError());
			};
			const timer = this.scheduler.setTimeout(() => {
				settle();
				log.debug("content-link: request timed out", { tabId, kind: cmd.kind, id, timeoutMs });
				reject(new Error(CONTENT_LINK_ERRORS.timeout));
			}, timeoutMs);
			this.pending.set(id, {
				tabId,
				resolve: (msg) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(msg as ReplyFor<K>);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			const wire = { ...cmd, id, timeoutMs: cmd.timeoutMs ?? timeoutMs } as unknown as GamePortCommand;
			try {
				entry.port.post(wire);
			} catch (error) {
				settle();
				reject(error instanceof Error ? error : new Error(errorMessage(error)));
			}
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
		this.controlledPointers.clear();
		this.failPending(null, CONTENT_LINK_ERRORS.disposed);
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
		if ("id" in msg && typeof msg.id === "string") {
			const p = this.pending.get(msg.id);
			if (p && p.tabId === tabId) {
				this.pending.delete(msg.id);
				this.scheduler.clearTimeout(p.timer);
				p.resolve(msg);
				return;
			}
		}
		for (const l of [...this.listeners]) l(tabId, msg);
	}

	private drop(tabId: number, entry: Entry, reason: string | undefined): void {
		if (this.ports.get(tabId) !== entry) return;
		for (const off of entry.offs) off();
		this.ports.delete(tabId);
		this.controlledPointers.delete(tabId);
		this.failPending(tabId, CONTENT_LINK_ERRORS.disconnected);
		log.debug("content-link: port disconnected", { tabId, reason: reason ?? null });
		for (const cb of [...this.disconnectListeners]) cb(tabId, reason);
	}

	private failPending(tabId: number | null, message: string): void {
		for (const [id, p] of [...this.pending]) {
			if (tabId !== null && p.tabId !== tabId) continue;
			this.pending.delete(id);
			this.scheduler.clearTimeout(p.timer);
			p.reject(new Error(message));
		}
	}
}
