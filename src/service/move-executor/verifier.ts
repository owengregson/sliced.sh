/**
 * Move verification (§9.3): ask the content adapter's `observeMove` over the
 * game port — a MutationObserver on the board and move list that answers
 * `ok` as soon as the piece stands on the destination square (or the
 * last-move / premove highlight covers orig + dest), `false` early when the
 * piece snapped back, and nothing at all until the budget runs out.
 *
 * `checkSquares` asks the colour-aware `boardCheck` question instead (own /
 * enemy / empty per square): the executor's pre-dispatch position guard uses
 * it when the geometry reply carries no `occupancy`, so a replacement capture
 * is never vetoed by the enemy piece standing on its destination.
 */

import { CONTENT_LINK_ERRORS } from "@core/constants/cdp";
import type { ExpectedMove } from "@core/constants/messages";
import { log } from "@core/logger";
import type { Occupancy } from "@core/motor/types";
import { errorMessage } from "@core/util/errors";
import { isAbortedError } from "@core/util/scheduler";
import type { ReplyFor, RequestInput } from "@service/content-link";
import type { Square } from "@typedefs/game";

export type VerifyOutcome = "ok" | "rejected" | "timeout" | "unavailable";

export interface VerifyResult {
	outcome: VerifyOutcome;
	reason?: string;
}

/** The slice of `ContentLink` the verifier needs. */
export interface VerifierLink {
	request(
		tabId: number,
		cmd: RequestInput<"observeMove">,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<ReplyFor<"observeMove">>;
}

/** The slice of `ContentLink` the position guard needs. */
export interface BoardCheckLink {
	request(
		tabId: number,
		cmd: RequestInput<"boardCheck">,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<ReplyFor<"boardCheck">>;
}

export type OccupancyResult =
	| { outcome: "ok"; occupancy: Partial<Record<Square, Occupancy>> }
	| { outcome: "unavailable"; reason: string };

/** An abort on `signal` ends the wait at once (`unavailable`, reason `aborted`). */
export async function verifyMove(
	link: VerifierLink,
	tabId: number,
	expected: ExpectedMove,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<VerifyResult> {
	try {
		const reply = await link.request(tabId, { kind: "observeMove", expected }, timeoutMs, signal);
		if (reply.ok) return { outcome: "ok" };
		return reply.reason === undefined
			? { outcome: "rejected" }
			: { outcome: "rejected", reason: reply.reason };
	} catch (error) {
		const message = errorMessage(error);
		if (message === CONTENT_LINK_ERRORS.timeout) return { outcome: "timeout" };
		if (!isAbortedError(error))
			log.debug("verifier: observeMove unavailable", { tabId, error: message });
		return { outcome: "unavailable", reason: message };
	}
}

/**
 * Colour-aware occupancy of `squares` right now (`boardCheck`). A timeout, a
 * missing port or an abort on `signal` is `unavailable`: the caller must not
 * dispatch on a guess.
 */
export async function checkSquares(
	link: BoardCheckLink,
	tabId: number,
	squares: Square[],
	timeoutMs: number,
	signal?: AbortSignal
): Promise<OccupancyResult> {
	try {
		const reply = await link.request(tabId, { kind: "boardCheck", squares }, timeoutMs, signal);
		return { outcome: "ok", occupancy: reply.occupancy };
	} catch (error) {
		const message = errorMessage(error);
		if (!isAbortedError(error))
			log.debug("verifier: boardCheck unavailable", { tabId, error: message });
		return { outcome: "unavailable", reason: message };
	}
}
