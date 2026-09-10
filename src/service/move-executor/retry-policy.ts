/**
 * Retry policy (§9.3, Appendix G §6): Tier 1 drag → Tier 2 click-click once
 * (or the reverse for a click-first hand), then report failure. Before every
 * retry the board is re-checked so a move that did land (slow verification)
 * is never played twice, and the retry waits `TIMINGS.executorRetryDelayMs`.
 * A board that cannot be checked at all (`unavailable`, from the verification
 * or the re-check) is terminal: nothing is dispatched on a guess.
 *
 * Every board check runs on a signal from `checkSignal()` — fresh at that
 * moment, so the cancel that interrupted the attempt never poisons it; only a
 * *further* cancel arriving during the check aborts it. An interrupted attempt
 * whose committed press went out (`pressed`) therefore always gets one bounded
 * `recheck()` (`EXECUTOR.recheckTimeoutMs`) and is reported truthfully:
 * `executed` when the board shows the move, its own outcome (`pressed: true`)
 * when it does not, and its own outcome with `verification-unavailable` in
 * `error` only when the re-check itself was unavailable. A drop that was fully
 * dispatched before a cancel (during the post-drop rest) is verified with the
 * short budget instead of the full one and never retried.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { ClickStyle, ExecutionResult } from "@core/motor/types";
import type { VerifyResult } from "./verifier";

export function otherTier(tier: ClickStyle): ClickStyle {
	return tier === "drag" ? "click" : "drag";
}

/** The tiers to try in order, capped at `EXECUTOR.maxAttempts`. */
export function tiersFor(style: ClickStyle): ClickStyle[] {
	return [style, otherTier(style)].slice(0, EXECUTOR.maxAttempts);
}

/** Delay before retry number `n` (1-based); the last registry entry repeats. */
export function retryDelayMs(n: number): number {
	const delays = TIMINGS.executorRetryDelayMs;
	const idx = Math.min(Math.max(0, n - 1), delays.length - 1);
	return delays[idx] ?? 0;
}

export interface RetryRunnerOptions {
	style: ClickStyle;
	/** Dispatch one attempt (`index` 0 = the full timed execution, later ones are instant retries). */
	attempt(tier: ClickStyle, index: number): Promise<ExecutionResult>;
	/** Verification after an attempt, bounded by `timeoutMs` and `signal`. */
	verify(timeoutMs: number, signal: AbortSignal): Promise<VerifyResult>;
	/** Short board re-check (`EXECUTOR.recheckTimeoutMs`) before a retry and after an interrupted attempt. */
	recheck(signal: AbortSignal): Promise<VerifyResult>;
	/** A signal that only a cancel arriving from now on aborts — never the one that already fired. */
	checkSignal(): AbortSignal;
	delay(ms: number): Promise<void>;
	verifyTimeoutMs: number;
	/** The execution's own signal (the attempts run on it). */
	signal?: AbortSignal;
}

function unavailable(
	base: ExecutionResult,
	attempts: number,
	verdict: VerifyResult
): ExecutionResult {
	log.warn("executor: board could not be checked; no further dispatch", { verdict });
	const r: ExecutionResult = {
		...base,
		ok: false,
		outcome: "failed",
		reason: EXECUTOR.reasons.verificationUnavailable,
		attempts,
	};
	if (verdict.reason !== undefined) r.error = verdict.reason;
	return r;
}

export async function runWithRetry(o: RetryRunnerOptions): Promise<ExecutionResult> {
	const tiers = tiersFor(o.style);
	let attempts = 0;
	let last: ExecutionResult | null = null;
	for (let i = 0; i < tiers.length; i++) {
		const tier = tiers[i] as ClickStyle;
		if (i > 0 && last) {
			await o.delay(retryDelayMs(i));
			if (o.signal?.aborted) {
				return { ...last, ok: false, outcome: "aborted", reason: EXECUTOR.reasons.aborted, attempts };
			}
			const pre = await o.recheck(o.checkSignal());
			if (pre.outcome === "ok") {
				log.info("executor: move landed before the retry; not re-dispatching", { tier: last.tier });
				return { ...last, ok: true, outcome: "executed", attempts };
			}
			if (pre.outcome === "unavailable") return unavailable(last, attempts, pre);
		}
		const result = await o.attempt(tier, i);
		if (result.outcome !== "skipped" || result.pressed) attempts += 1;
		if (!result.ok) {
			// `pressedAny`, not `pressed`: a §9.3a **preview** press is a real `mousedown` on a real
			// square and never sets the committed flag, so a window that ended between it and its
			// release (a reflow caught mid-preview, a focus skip inside a preview drag) could have
			// left the page with `down` on one square and `up` on another — a submitted move that
			// nothing would ever have looked for. "The board is always looked at" only held for the
			// committed press until now.
			if (!result.pressed && result.pressedAny !== true) return { ...result, attempts };
			// A press went out before the skip/abort: the release may have moved the piece. One
			// bounded re-check on a fresh signal decides.
			const late = await o.recheck(o.checkSignal());
			if (late.outcome === "ok") {
				log.info("executor: interrupted attempt still landed the move", { outcome: result.outcome });
				const upgraded: ExecutionResult = { ...result, ok: true, outcome: "executed", attempts };
				delete upgraded.reason;
				return upgraded;
			}
			if (late.outcome === "unavailable") {
				log.warn("executor: interrupted attempt could not be checked", { late });
				return { ...result, error: EXECUTOR.reasons.verificationUnavailable, attempts };
			}
			return { ...result, attempts };
		}
		// A cancel that arrived after the drop (post-drop rest) bounds the verification and ends retries.
		const cancelled = o.signal?.aborted === true;
		const verdict = await o.verify(
			cancelled ? EXECUTOR.recheckTimeoutMs : o.verifyTimeoutMs,
			o.checkSignal()
		);
		if (verdict.outcome === "ok") return { ...result, attempts };
		if (verdict.outcome === "unavailable") return unavailable(result, attempts, verdict);
		log.warn("executor: move not verified", { tier, verdict, cancelled });
		if (cancelled) {
			return { ...result, ok: false, outcome: "aborted", reason: EXECUTOR.reasons.aborted, attempts };
		}
		last = result;
	}
	const base = last as ExecutionResult;
	return { ...base, ok: false, outcome: "failed", reason: EXECUTOR.reasons.unverified, attempts };
}
