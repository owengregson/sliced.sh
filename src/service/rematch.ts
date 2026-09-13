/**
 * Rematching titled players (owner's brief, 2026-09-13): "if the user is a titled player
 * (candidate master, fm, gm, etc.) we automatically send a rematch request after the game ends
 * (only one time) — or, if they sent us a rematch request we automatically accept it … if the
 * rematch isnt accepted after 15 seconds we dismiss it and keep queueing regular games."
 *
 * Two halves. The **decision** is pure: `rematchEligible` says whether the finished game's
 * opponent earns the step (titled, the setting on, not yet rematched this playing session) and
 * `markRematched` records the once-only mark on the playing session the auto-queue persists. The
 * **step** (`RematchStep.run`) is the one bounded wait: read whether the opponent's offer is
 * showing, click Accept if so or Rematch if not — through the queue's own hand-driven click path,
 * never a content-script click — then wait up to `REMATCH.acceptTimeoutMs` for the next game,
 * accepting an offer of theirs that appears meanwhile, and withdraw ours when nobody took it.
 *
 * `AutoQueue` owns the timers, the entry and the fall-through to the ordinary queue click; it
 * calls `gameStarted` when the next game is observed, which is what ends the wait.
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
import type { Settings } from "@typedefs/settings";
import type { PlayingSession } from "@typedefs/storage";

/** What the decision needs to know about the finished game's opponent. */
export interface RematchOpponent {
	name: string;
	title?: string | undefined;
}

/** Any title text the card carried (normalised by the adapter) makes the opponent titled. */
export function isTitled(opponent: RematchOpponent | null | undefined): boolean {
	return typeof opponent?.title === "string" && opponent.title !== "";
}

/** Whether `name` still has a rematch left in this playing session (`REMATCH.offersPerOpponent`). */
export function rematchOffersLeft(session: PlayingSession | undefined, name: string): boolean {
	const offered = session?.rematched?.filter((n) => n === name).length ?? 0;
	return offered < REMATCH.offersPerOpponent;
}

/**
 * The step runs for this opponent when: the queue is on and `rematchTitled` is on, the opponent
 * is known by name and titled, and this playing session has not rematched them yet. An untitled
 * opponent never gets an offer and never has theirs accepted — the owner's rule is about titled
 * players.
 */
export function rematchEligible(
	opponent: RematchOpponent | null | undefined,
	settings: Pick<Settings["automation"], "autoQueue" | "rematchTitled">,
	session: PlayingSession | undefined
): boolean {
	if (!settings.autoQueue || !settings.rematchTitled) return false;
	if (!opponent || opponent.name === "" || !isTitled(opponent)) return false;
	return rematchOffersLeft(session, opponent.name);
}

/** Record the offer/accept on the playing session (the caller persists it). */
export function markRematched(session: PlayingSession, name: string): void {
	const rematched = session.rematched ?? [];
	rematched.push(name);
	session.rematched = rematched;
}

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
