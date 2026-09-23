import { CONTENT_LINK_ERRORS } from "@core/constants/cdp";
import type { GamePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { AbortedError, type Scheduler } from "@core/util/scheduler";

interface Pending {
	tabId: number;
	resolve: (msg: GamePortMessage) => void;
	reject: (error: Error) => void;
	timer: unknown;
}

/** The game-port requests awaiting their reply, correlated by `id`, each with its own timeout. */
export class PendingRequests {
	private readonly pending = new Map<string, Pending>();
	private seq = 0;

	constructor(private readonly scheduler: Scheduler) {}

	/**
	 * Allocate an id, `post(id)` the request and resolve with the reply carrying it. An abort on
	 * `signal` rejects at once with `AbortedError` (the entry and its timer are dropped; a late
	 * reply is ignored); a throwing `post` rejects with its error.
	 */
	open<R extends GamePortMessage>(
		tabId: number,
		kind: string,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		post: (id: string) => void
	): Promise<R> {
		this.seq += 1;
		const id = `r${this.seq}`;
		return new Promise<R>((resolve, reject) => {
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
				log.debug("content-link: request timed out", { tabId, kind, id, timeoutMs });
				reject(new Error(CONTENT_LINK_ERRORS.timeout));
			}, timeoutMs);
			this.pending.set(id, {
				tabId,
				resolve: (msg) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(msg as R);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				post(id);
			} catch (error) {
				settle();
				reject(error instanceof Error ? error : new Error(errorMessage(error)));
			}
		});
	}

	/** Deliver `msg` to the request it answers on `tabId`; `false` when it answers none. */
	resolve(tabId: number, msg: GamePortMessage): boolean {
		if (!("id" in msg) || typeof msg.id !== "string") return false;
		const p = this.pending.get(msg.id);
		if (!p || p.tabId !== tabId) return false;
		this.pending.delete(msg.id);
		this.scheduler.clearTimeout(p.timer);
		p.resolve(msg);
		return true;
	}

	/** Reject every request on `tabId` (all of them for `null`) with `message`. */
	fail(tabId: number | null, message: string): void {
		for (const [id, p] of [...this.pending]) {
			if (tabId !== null && p.tabId !== tabId) continue;
			this.pending.delete(id);
			this.scheduler.clearTimeout(p.timer);
			p.reject(new Error(message));
		}
	}
}
