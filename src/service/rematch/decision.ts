/**
 * The rematch decision (2026-09-13), pure: whether the finished game's opponent earns the step
 * and the once-only mark on the playing session the auto-queue persists.
 */

import { REMATCH } from "@core/constants/rematch";
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
