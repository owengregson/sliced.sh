/** Retry post-game controls until a new game is observed, retaining the original wait deadline. */
import { REMATCH } from "@core/constants/rematch";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import { defaultNow, defaultScheduler, type Scheduler, sleep } from "@core/util/scheduler";
import { beginPlayingSession, finishPlayingSessionGame } from "@service/playing-session";
import {
	markRematched,
	type RematchOpponent,
	type RematchStep,
	rematchEligible,
	rematchOffersLeft,
} from "@service/rematch";
import type { Settings } from "@typedefs/settings";
import type { PendingAutoQueues, PlayingSession } from "@typedefs/storage";

export interface AutoQueueView {
	dueAt: number;
	attempts: number;
	status: "waiting" | "break" | "retrying" | "searching" | "rematch";
}
interface Entry extends AutoQueueView {
	gameId: string | null;
	timer?: unknown;
	controller?: AbortController;
	/**
	 * The rematch step (2026-09-13) still to run at `dueAt` (`pending`), or running now
	 * (`running`: the offer is out, `dueAt` is when the ordinary click follows).
	 */
	rematch?: { opponent: string; phase: "pending" | "running" };
	/** The pre-click poll for an incoming offer while `rematch` is pending. */
	poll?: unknown;
}
export interface AutoQueueOptions {
	/** Discovers and activates a queue control using the virtual mouse. */
	attempt(
		tabId: number,
		gameId: string | null,
		signal: AbortSignal
	): Promise<{
		status: "started" | "searching" | "not-ready" | "in-game";
	}>;
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
	/**
	 * The rematch step for titled opponents (2026-09-13); absent means the queue never rematches.
	 * `allowed` is `automation.rematchTitled` at the moment the step would run.
	 */
	rematch?: {
		step: Pick<RematchStep, "run" | "gameStarted" | "incoming">;
		allowed(tabId: number): boolean;
	};
	/**
	 * The entry moved into its session break *after* scheduling — a rematch step that was not
	 * taken while the break was due (the session releases the mouse on it, as it does when the
	 * break is scheduled directly).
	 */
	onBreak?: (tabId: number) => void;
}

export class AutoQueue {
	readonly ready: Promise<void>;
	private readonly entries = new Map<number, Entry>();
	private readonly sessions = new Map<number, PlayingSession>();
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

	/**
	 * `opponent` (2026-09-13) is the finished game's opponent, as far as the session read it; a
	 * titled one with a rematch left earns the rematch step before the ordinary queue click, and
	 * before the session's break — the break starts after the rematch game.
	 */
	async schedule(
		tabId: number,
		gameId: string | null,
		settings: Settings["automation"],
		opponent?: RematchOpponent | null
	): Promise<void> {
		const generation = this.generations.get(tabId);
		await this.ready;
		if (this.disposed || generation !== this.generations.get(tabId)) return;
		if (this.options.canQueue(tabId, gameId) === "cancel") return;
		const previous = this.entries.get(tabId);
		if (previous?.gameId === gameId) return;
		this.clearPending(tabId);
		const now = this.now();
		const session =
			this.sessions.get(tabId) ?? beginPlayingSession(gameId, now, settings, this.options.rng);
		this.sessions.set(tabId, session);
		if (!finishPlayingSessionGame(session, gameId, now, settings, this.options.rng)) return;
		const rematch =
			this.options.rematch && rematchEligible(opponent, settings, session) && opponent
				? opponent.name
				: null;
		const [lo, hi] = TIMINGS.autoQueueDelayRangeMs;
		// A due break waits for the rematch step: the delay is the ordinary short one.
		const delay =
			session.breakUntil === null || rematch !== null
				? lo + this.options.rng.next() * Math.max(0, hi - lo)
				: Math.max(0, session.breakUntil - now);
		const entry: Entry = {
			gameId,
			dueAt: now + delay,
			attempts: 0,
			status: session.breakUntil === null || rematch !== null ? "waiting" : "break",
			...(rematch !== null ? { rematch: { opponent: rematch, phase: "pending" as const } } : {}),
		};
		this.entries.set(tabId, entry);
		this.arm(tabId, entry);
		await this.changed();
		log.info("auto-queue: scheduled", { tabId, delayMs: delay, rematch });
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
		return [...new Set([...this.entries.keys(), ...this.sessions.keys()])];
	}

	/** Includes active playing sessions, whose progress must survive matchmaking navigation. */
	isTracking(tabId: number): boolean {
		return this.entries.has(tabId) || this.sessions.has(tabId);
	}

	async observedGame(
		tabId: number,
		gameId: string,
		settings?: Settings["automation"]
	): Promise<void> {
		const generation = this.generations.get(tabId);
		await this.ready;
		if (this.disposed || generation !== this.generations.get(tabId)) return;
		const entry = this.entries.get(tabId);
		// Reconnecting to the finished board must preserve its original break/retry deadline.
		if (entry?.gameId === gameId) return;
		// A rematch offer answered: the step resolves `started` before its entry is cleared.
		const rematching = entry?.rematch?.phase === "running";
		if (rematching) this.options.rematch?.step.gameStarted(tabId);
		this.clearPending(tabId);
		const previous = this.sessions.get(tabId);
		if (settings?.autoQueue) {
			const session =
				!previous || (previous.gameId !== gameId && previous.breakUntil !== null && !rematching)
					? beginPlayingSession(gameId, this.now(), settings, this.options.rng)
					: previous;
			// The rematch game plays inside the current session; a break that was due waits for it
			// — the session has already expired, so the rematch game's end samples a fresh break.
			if (rematching && session.breakUntil !== null) session.breakUntil = null;
			session.gameId = gameId;
			this.sessions.set(tabId, session);
		} else if (previous) previous.gameId = gameId;
		await this.changed();
	}

	/** The persisted alarm and reconnects use the same timer path; only one request can be in flight. */
	async wake(): Promise<void> {
		await this.ready;
		if (this.disposed) return;
		for (const tabId of this.tabIds()) {
			const entry = this.entries.get(tabId);
			const gameId = entry?.gameId ?? this.sessions.get(tabId)?.gameId ?? null;
			if (this.options.canQueue(tabId, gameId) === "cancel") this.cancel(tabId);
			else if (entry && !entry.controller) this.arm(tabId, entry);
		}
	}

	cancel(tabId: number): void {
		this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
		const tracked = this.isTracking(tabId);
		this.clearPending(tabId);
		this.sessions.delete(tabId);
		if (tracked) void this.changed();
	}

	private clearPending(tabId: number): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;
		this.entries.delete(tabId);
		if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
		this.clearPoll(entry);
		entry.controller?.abort();
	}

	private clearPoll(entry: Entry): void {
		if (entry.poll === undefined) return;
		this.scheduler.clearTimeout(entry.poll);
		delete entry.poll;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifetime.abort();
		// Runtime disposal stops input, but only explicit cancellation erases durable intent.
		for (const tabId of this.entries.keys()) this.clearPending(tabId);
		this.sessions.clear();
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
					if (record.session) this.sessions.set(tabId, { ...record.session });
					if (record.dueAt === null) continue;
					const entry: Entry = {
						gameId: record.gameId,
						dueAt: record.dueAt,
						attempts: 0,
						status:
							record.session?.breakUntil === record.dueAt && record.dueAt > this.now()
								? "break"
								: "waiting",
						...(record.rematch !== undefined
							? { rematch: { opponent: record.rematch, phase: "pending" as const } }
							: {}),
					};
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
		if (entry.rematch?.phase === "pending") this.armIncomingPoll(tabId, entry);
	}

	/**
	 * While the rematch step is pending, look for the opponent's own offer every
	 * `REMATCH.incomingPollMs` and, when it shows, run the step at once instead of at `dueAt` —
	 * bounded by the delay itself: the last poll is the due timer.
	 */
	private armIncomingPoll(tabId: number, entry: Entry): void {
		this.clearPoll(entry);
		const rematch = this.options.rematch;
		if (!rematch || entry.dueAt - this.now() <= REMATCH.incomingPollMs) return;
		entry.poll = this.scheduler.setTimeout(() => {
			delete entry.poll;
			void this.pollIncoming(tabId, entry, rematch);
		}, REMATCH.incomingPollMs);
	}

	private async pollIncoming(
		tabId: number,
		entry: Entry,
		rematch: NonNullable<AutoQueueOptions["rematch"]>
	): Promise<void> {
		const current = () =>
			!this.disposed &&
			this.entries.get(tabId) === entry &&
			!entry.controller &&
			entry.rematch?.phase === "pending";
		if (!current() || this.options.canQueue(tabId, entry.gameId) !== "allow") {
			if (current()) this.armIncomingPoll(tabId, entry);
			return;
		}
		let incoming = false;
		try {
			incoming = await rematch.step.incoming(tabId, this.lifetime.signal);
		} catch {
			/* the tab cannot answer right now; the due timer still runs */
		}
		if (!current()) return;
		if (!incoming) {
			this.armIncomingPoll(tabId, entry);
			return;
		}
		log.info("auto-queue: incoming rematch offer during the delay", { tabId });
		if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
		delete entry.timer;
		void this.attempt(tabId, entry);
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
		if (entry.rematch?.phase === "pending" && !(await this.rematchStep(tabId, entry))) return;
		const controller = new AbortController();
		entry.controller = controller;
		entry.attempts += 1;
		entry.status = entry.attempts === 1 ? "waiting" : "retrying";
		const retry = Math.min(TIMINGS.autoQueueRetryMaxMs, TIMINGS.autoQueueRetryMs * entry.attempts);
		entry.dueAt = this.now() + TIMINGS.autoQueueRequestTimeoutMs + retry;
		this.changed();
		let delay = retry;
		try {
			const reply = await this.options.attempt(tabId, entry.gameId, controller.signal);
			if (this.entries.get(tabId) !== entry) return;
			if (reply.status === "in-game") {
				this.clearPending(tabId);
				void this.changed();
				return;
			}
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

	/**
	 * The rematch step (2026-09-13), before the ordinary click. Resolves `true` when the caller
	 * should go on to that click at once (the offer was not taken, or the step could not run),
	 * `false` when the entry was resolved here — the next game started, a game is on, or the
	 * session's due break was taken instead.
	 */
	private async rematchStep(tabId: number, entry: Entry): Promise<boolean> {
		const plan = entry.rematch;
		const rematch = this.options.rematch;
		const session = this.sessions.get(tabId);
		this.clearPoll(entry);
		if (!plan || !rematch) return true;
		if (!rematch.allowed(tabId) || !rematchOffersLeft(session, plan.opponent)) {
			delete entry.rematch;
			return this.afterRematch(tabId, entry, session);
		}
		const controller = new AbortController();
		entry.controller = controller;
		plan.phase = "running";
		entry.status = "rematch";
		entry.dueAt = this.now() + REMATCH.acceptTimeoutMs;
		this.changed();
		let outcome: string;
		try {
			const result = await rematch.step.run(tabId, entry.gameId, controller.signal, {
				onClicked: () => {
					// The once-only mark, persisted at the press so a reload cannot re-offer.
					if (session) markRematched(session, plan.opponent);
					void this.changed();
				},
			});
			outcome = result.outcome;
		} catch (error) {
			outcome = "not-ready";
			if (!controller.signal.aborted) log.warn("auto-queue: rematch step failed", { tabId, error });
		} finally {
			delete entry.controller;
		}
		if (this.disposed || this.entries.get(tabId) !== entry) return false;
		delete entry.rematch;
		log.info("auto-queue: rematch step finished", { tabId, opponent: plan.opponent, outcome });
		if (outcome === "in-game") {
			this.clearPending(tabId);
			void this.changed();
			return false;
		}
		return this.afterRematch(tabId, entry, session);
	}

	/** No rematch game: a break that was due starts now; otherwise the ordinary click follows at once. */
	private afterRematch(tabId: number, entry: Entry, session: PlayingSession | undefined): boolean {
		if (session?.breakUntil === null || session?.breakUntil === undefined) return true;
		entry.status = "break";
		entry.dueAt = session.breakUntil;
		this.arm(tabId, entry);
		this.changed();
		this.options.onBreak?.(tabId);
		return false;
	}

	private async changed(): Promise<void> {
		this.options.onChanged?.();
		if (!this.options.persistence) return;
		do {
			const records: PendingAutoQueues = {};
			for (const tabId of this.tabIds()) {
				const entry = this.entries.get(tabId);
				const session = this.sessions.get(tabId);
				records[String(tabId)] = {
					gameId: entry?.gameId ?? session?.gameId ?? null,
					dueAt: entry?.dueAt ?? null,
					...(session ? { session: { ...session } } : {}),
					...(entry?.rematch?.phase === "pending" ? { rematch: entry.rematch.opponent } : {}),
				};
			}
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
