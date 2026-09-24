/**
 * The rematch step (2026-09-13): the one bounded wait after a game against a titled opponent —
 * see `@service/rematch`.
 */

import { REMATCH } from "@core/constants/rematch";
import { log } from "@core/logger";
import {
	defaultNow,
	defaultScheduler,
	type Scheduler,
	sleep,
	throwIfAborted,
} from "@core/util/scheduler";

/** The clicks the step performs; `decline` exists on the page but the step never uses it. */
export type RematchClickAction = "rematch" | "accept" | "cancel";
export type RematchClickStatus = "started" | "not-ready" | "in-game";

export interface RematchStepOptions {
	/** Passive read: is the opponent's offer showing on `tabId`? Rejects when the tab cannot answer. */
	incoming(tabId: number, signal: AbortSignal): Promise<boolean>;
	/**
	 * Click a rematch control through the virtual hand — the queue's own "new game" click path.
	 * `started` means the press landed on the control; `not-ready` that no such control was there
	 * (or it moved under the hand); `in-game` that a game is already on the board.
	 */
	click(
		tabId: number,
		gameId: string | null,
		action: RematchClickAction,
		signal: AbortSignal
	): Promise<{ status: RematchClickStatus }>;
	scheduler?: Scheduler;
	now?: () => number;
}

export type RematchOutcome = "started" | "expired" | "not-ready" | "in-game" | "aborted";

export interface RematchResult {
	outcome: RematchOutcome;
	/** A Rematch or Accept press landed — the once-only mark applies whatever followed. */
	clicked: boolean;
}

export interface RematchRunHooks {
	/** Called the moment a Rematch / Accept press landed, before the wait begins. */
	onClicked?: () => void;
}

export class RematchStep {
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly waiting = new Map<number, () => void>();

	constructor(private readonly options: RematchStepOptions) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.now = options.now ?? defaultNow;
	}

	/** The passive "is their offer showing" read, for the auto-queue's pre-click poll. */
	incoming(tabId: number, signal: AbortSignal): Promise<boolean> {
		return this.options.incoming(tabId, signal);
	}

	/** The next game is on the board of `tabId`: a run waiting there resolves `started`. */
	gameStarted(tabId: number): void {
		this.waiting.get(tabId)?.();
	}

	/** Whether a run is waiting for the answer on `tabId`. */
	isWaiting(tabId: number): boolean {
		return this.waiting.has(tabId);
	}

	async run(
		tabId: number,
		gameId: string | null,
		signal: AbortSignal,
		hooks: RematchRunHooks = {}
	): Promise<RematchResult> {
		let started = false;
		let clicked = false;
		const startedPromise = new Promise<void>((resolve) => {
			this.waiting.set(tabId, () => {
				started = true;
				resolve();
			});
		});
		const done = (outcome: RematchOutcome): RematchResult => ({ outcome, clicked });
		try {
			throwIfAborted(signal);
			// Their offer first: an incoming panel replaces the Rematch button, so it is also the
			// only click the page offers at that moment.
			let action: RematchClickAction = (await this.options.incoming(tabId, signal))
				? "accept"
				: "rematch";
			if (started) return done("started");
			let reply = await this.options.click(tabId, gameId, action, signal);
			if (started) return done("started");
			if (reply.status === "not-ready" && action === "accept") {
				// The panel went away between the read and the click; our own offer, then.
				action = "rematch";
				reply = await this.options.click(tabId, gameId, action, signal);
				if (started) return done("started");
			}
			if (reply.status === "in-game") return done("in-game");
			if (reply.status !== "started") return done("not-ready");
			clicked = true;
			hooks.onClicked?.();
			log.info("rematch: offer sent", { tabId, action });
			const deadline = this.now() + REMATCH.acceptTimeoutMs;
			while (!started) {
				const remaining = deadline - this.now();
				if (remaining <= 0) break;
				await Promise.race([
					startedPromise,
					sleep(Math.min(remaining, REMATCH.incomingPollMs), this.scheduler, signal),
				]);
				if (started) break;
				throwIfAborted(signal);
				// They offered at the same time as we did: take theirs rather than wait on ours.
				if (action === "rematch" && (await this.options.incoming(tabId, signal))) {
					if (started) break;
					const accept = await this.options.click(tabId, gameId, "accept", signal);
					if (started) break;
					if (accept.status === "in-game") return done("in-game");
					if (accept.status === "started") {
						action = "accept";
						log.info("rematch: their offer accepted while ours was pending", { tabId });
					}
				}
			}
			if (started) return done("started");
			// Nobody took it: withdraw our offer when the page has a cancel, then move on.
			if (action === "rematch") {
				const cancel = await this.options.click(tabId, gameId, "cancel", signal);
				if (started) return done("started");
				log.info("rematch: not taken in time", { tabId, withdrawn: cancel.status === "started" });
			} else log.info("rematch: accepted but no game started in time", { tabId });
			return done("expired");
		} catch (error) {
			if (started) return done("started");
			if (signal.aborted) return done("aborted");
			log.debug("rematch: step stopped before completing", { tabId, error });
			return done("not-ready");
		} finally {
			this.waiting.delete(tabId);
		}
	}
}
