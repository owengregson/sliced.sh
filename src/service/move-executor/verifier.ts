/**
 * Move verification (§9.3): ask the content adapter's `observeMove` over the
 * game port — a MutationObserver on the board and move list that answers
 * `ok` as soon as the piece stands on the destination square (or the
 * last-move / premove highlight covers orig + dest), `false` early when the
 * piece snapped back, and nothing at all until the budget runs out.
 */

import { CONTENT_LINK_ERRORS } from "@core/constants/cdp";
import type { ExpectedMove } from "@core/constants/messages";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { isAbortedError } from "@core/util/scheduler";
import type { ReplyFor, RequestInput } from "@service/content-link";

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
