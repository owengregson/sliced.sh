/**
 * What the Waiting view says, from a snapshot alone: the status line (auto-queue countdowns,
 * reading, connected) and the auto-play toggle's hint.
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { COPY } from "../../copy";
import { formatCountdown } from "../../format";
import type { AutoPlayState } from "../auto-play-state";

const MS_PER_SECOND = 1000;

export interface WaitingStatus {
	text: string;
	/** A visible countdown is running (the line is a `timer` that re-renders every second). */
	counting: boolean;
	/** The status dot warns (assistant off, reading, or a queue step in progress). */
	warn: boolean;
}

export function waitingStatus(snapshot: PanelSnapshot, now: number): WaitingStatus {
	const assistantOff = !snapshot.settings.enabled;
	const reading = snapshot.session.state === "idle";
	const queue =
		!assistantOff && snapshot.settings.automation.autoQueue ? snapshot.session.autoQueue : undefined;
	const remaining = queue ? queue.dueAt - now : 0;
	// The rematch step (2026-09-13) counts down to the ordinary queue click, in seconds.
	const rematching = queue?.status === "rematch" && remaining > 0;
	const counting =
		rematching ||
		((queue?.status === "waiting" || queue?.status === "break") &&
			queue.attempts === 0 &&
			remaining > 0);
	const text = assistantOff
		? COPY.move.disabled
		: queue
			? rematching
				? COPY.waiting.queueRematch(String(Math.ceil(remaining / MS_PER_SECOND)))
				: counting
					? queue.status === "break"
						? COPY.waiting.queueBreak(formatCountdown(remaining))
						: COPY.waiting.queueDelay(formatCountdown(remaining))
					: queue.status === "searching"
						? COPY.waiting.queueSearching
						: queue.status === "retrying"
							? COPY.waiting.queueRetrying
							: COPY.waiting.queueStarting
			: reading
				? COPY.waiting.reading
				: COPY.waiting.watching;
	return { text, counting, warn: assistantOff || reading || queue !== undefined };
}

/**
 * §4.4: with the master switch off nothing can be armed (the service worker refuses), so the hint
 * says so; otherwise it follows the saved intent and the hand.
 */
export function autoplayHint(snapshot: PanelSnapshot, auto: AutoPlayState): string {
	return !snapshot.settings.enabled
		? COPY.waiting.autoplayOff
		: auto.waiting
			? COPY.toggle.waitingHint
			: snapshot.autoMove.armed
				? COPY.waiting.preArmed
				: COPY.waiting.autoplayTooltip;
}
