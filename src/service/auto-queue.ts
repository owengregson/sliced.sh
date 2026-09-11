/** Retry post-game controls until a new game is observed, retaining the original wait deadline. */
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import { defaultNow, defaultScheduler, type Scheduler, sleep } from "@core/util/scheduler";
import type { ContentLink } from "@service/content-link";
import type { Settings } from "@typedefs/settings";
import type { PendingAutoQueues } from "@typedefs/storage";

export interface AutoQueueView {
	dueAt: number;
	attempts: number;
	status: "waiting" | "retrying" | "searching";
}
interface Entry extends AutoQueueView {
	gameId: string | null;
	timer?: unknown;
	controller?: AbortController;
}
export interface AutoQueueOptions {
	link: Pick<ContentLink, "request">;
	scheduler?: Scheduler;
	now?: () => number;
	rng: Rng;
	/** A missing session/unknown settings holds; a changed game or disabled setting cancels. */
	canQueue(tabId: number, gameId: string | null): "allow" | "hold" | "cancel";
	persistence?: {
		load(): Promise<PendingAutoQueues>;
		save(records: PendingAutoQueues): Promise<void>;
	};
	onChanged?: () => void;
}

export class AutoQueue {
	readonly ready: Promise<void>;
	private readonly entries = new Map<number, Entry>();
	private readonly generations = new Map<number, number>();
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private disposed = false;
	private readonly lifetime = new AbortController();

	constructor(private readonly options: AutoQueueOptions) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.now = options.now ?? defaultNow;
		this.ready = this.restore();
	}

	async schedule(
		tabId: number,
		gameId: string | null,
		settings: Settings["automation"]
	): Promise<void> {
		const generation = this.generations.get(tabId);
		await this.ready;
		if (this.disposed || generation !== this.generations.get(tabId)) return;
		if (this.options.canQueue(tabId, gameId) === "cancel") return;
		const previous = this.entries.get(tabId);
		if (previous?.gameId === gameId) return;
		this.cancel(tabId);
		const [lo, hi] = settings.autoQueueDelayEnabled
			? [TIMINGS.autoQueueMinuteMs, settings.autoQueueDelayMaxMinutes * TIMINGS.autoQueueMinuteMs]
			: TIMINGS.autoQueueDelayRangeMs;
		const delay = lo + this.options.rng.next() * Math.max(0, hi - lo);
		const entry: Entry = { gameId, dueAt: this.now() + delay, attempts: 0, status: "waiting" };
		this.entries.set(tabId, entry);
		this.arm(tabId, entry);
		await this.changed();
		log.info("auto-queue: scheduled", { tabId, delayMs: delay });
	}

	view(tabId: number): AutoQueueView | undefined {
		const entry = this.entries.get(tabId);
		return entry ? { dueAt: entry.dueAt, attempts: entry.attempts, status: entry.status } : undefined;
	}

	isPending(tabId: number): boolean {
		return this.entries.has(tabId);
	}

	hasPending(): boolean {
		return this.entries.size > 0;
	}

	tabIds(): number[] {
		return [...this.entries.keys()];
	}

	async observedGame(tabId: number, gameId: string): Promise<void> {
		await this.ready;
		const entry = this.entries.get(tabId);
		if (entry && entry.gameId !== gameId) this.cancel(tabId);
	}

	/** The persisted alarm and reconnects use the same timer path; only one request can be in flight. */
	async wake(): Promise<void> {
		await this.ready;
		if (this.disposed) return;
		for (const [tabId, entry] of this.entries) {
			if (this.options.canQueue(tabId, entry.gameId) === "cancel") this.cancel(tabId);
			else if (!entry.controller) this.arm(tabId, entry);
		}
	}

	cancel(tabId: number): void {
		this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
		const entry = this.entries.get(tabId);
		if (!entry) return;
		this.entries.delete(tabId);
		if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
		entry.controller?.abort();
		this.changed();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifetime.abort();
		for (const tabId of this.entries.keys()) this.cancel(tabId);
	}

	private async restore(): Promise<void> {
		if (!this.options.persistence) return;
		while (!this.disposed)
			try {
				const records = await this.options.persistence.load();
				if (this.disposed) return;
				for (const [key, record] of Object.entries(records)) {
					const tabId = Number(key);
					if (this.generations.has(tabId)) continue;
					const entry: Entry = { ...record, attempts: 0, status: "waiting" };
					this.entries.set(tabId, entry);
					this.arm(tabId, entry);
				}
				this.changed();
				return;
			} catch (error) {
				log.warn("auto-queue: restore failed; retrying", error);
				await sleep(TIMINGS.autoQueueRetryMs, this.scheduler, this.lifetime.signal);
			}
	}

	private arm(tabId: number, entry: Entry): void {
		if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
		entry.timer = this.scheduler.setTimeout(
			() => {
				delete entry.timer;
				void this.attempt(tabId, entry);
			},
			Math.max(0, entry.dueAt - this.now())
		);
	}

	private async attempt(tabId: number, entry: Entry): Promise<void> {
		if (this.disposed || this.entries.get(tabId) !== entry || entry.controller) return;
		const gate = this.options.canQueue(tabId, entry.gameId);
		if (gate === "cancel") return this.cancel(tabId);
		if (gate === "hold") {
			entry.status = "retrying";
			entry.dueAt = this.now() + TIMINGS.autoQueueRetryMs;
			this.arm(tabId, entry);
			this.changed();
			return;
		}
		const controller = new AbortController();
		entry.controller = controller;
		entry.attempts += 1;
		entry.status = entry.attempts === 1 ? "waiting" : "retrying";
		const retry = Math.min(TIMINGS.autoQueueRetryMaxMs, TIMINGS.autoQueueRetryMs * entry.attempts);
		entry.dueAt = this.now() + TIMINGS.autoQueueRequestTimeoutMs + retry;
		this.changed();
		let delay = retry;
		try {
			const reply = await this.options.link.request(
				tabId,
				{ kind: "startNewGame", gameId: entry.gameId },
				TIMINGS.autoQueueRequestTimeoutMs,
				controller.signal
			);
			if (this.entries.get(tabId) !== entry) return;
			if (reply.status === "in-game") return this.cancel(tabId);
			if (reply.status === "started" || reply.status === "searching") {
				entry.status = "searching";
				delay = TIMINGS.autoQueueSearchPollMs;
			} else entry.status = "retrying";
			log.debug("auto-queue: control result", {
				tabId,
				status: reply.status,
				attempts: entry.attempts,
			});
		} catch (error) {
			entry.status = "retrying";
			if (!controller.signal.aborted)
				log.warn("auto-queue: request failed; retry scheduled", { tabId, error });
		} finally {
			delete entry.controller;
			if (!this.disposed && this.entries.get(tabId) === entry) {
				entry.dueAt = this.now() + delay;
				this.arm(tabId, entry);
				this.changed();
			}
		}
	}

	private async changed(): Promise<void> {
		this.options.onChanged?.();
		if (!this.options.persistence) return;
		do {
			const records: PendingAutoQueues = {};
			for (const [tabId, entry] of this.entries)
				records[String(tabId)] = { gameId: entry.gameId, dueAt: entry.dueAt };
			try {
				await this.options.persistence.save(records);
				return;
			} catch (error) {
				log.warn("auto-queue: save failed; retrying", error);
				await sleep(TIMINGS.autoQueueRetryMs, this.scheduler, this.lifetime.signal);
			}
		} while (!this.disposed);
	}
}
