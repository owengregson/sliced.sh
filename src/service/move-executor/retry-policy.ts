/**
 * Retry policy (§9.3, Appendix G §6): Tier 1 drag → Tier 2 click-click once
 * (or the reverse for a click-first hand), then report failure. Before every
 * retry the board is re-checked so a move that did land (slow verification)
 * is never played twice, and the retry waits `TIMINGS.executorRetryDelayMs`.
 * A board that cannot be checked at all (`unavailable`, from the verification
 * or the re-check) is terminal: nothing is dispatched on a guess. Skips,
 * aborts and dispatch failures are final too — but when the committed press
 * went out (`pressed`) the release may have landed the move, so they are
 * verified once and upgraded to `executed` if the board shows the move.
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
	/** Full-budget verification after an attempt. */
	verify(timeoutMs: number): Promise<VerifyResult>;
	/** Short board re-check before a retry and after an interrupted attempt (never double-move). */
	recheck(): Promise<VerifyResult>;
	delay(ms: number): Promise<void>;
	verifyTimeoutMs: number;
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
			const pre = await o.recheck();
			if (pre.outcome === "ok") {
				log.info("executor: move landed before the retry; not re-dispatching", { tier: last.tier });
				return { ...last, ok: true, outcome: "executed", attempts };
			}
			if (pre.outcome === "unavailable") return unavailable(last, attempts, pre);
		}
		const result = await o.attempt(tier, i);
		if (result.outcome !== "skipped" || result.pressed) attempts += 1;
		if (!result.ok) {
			if (!result.pressed) return { ...result, attempts };
			// The committed press went out before the skip/abort: the release may have moved the
			// piece. A short re-check (abortable) decides; a cancel must never keep the hand busy.
			const late = await o.recheck();
			if (o.signal?.aborted && result.outcome === "aborted") return { ...result, attempts };
			if (late.outcome === "ok") {
				log.info("executor: interrupted attempt still landed the move", { outcome: result.outcome });
				const upgraded: ExecutionResult = { ...result, ok: true, outcome: "executed", attempts };
				delete upgraded.reason;
				return upgraded;
			}
			if (late.outcome === "unavailable") {
				log.warn("executor: interrupted attempt could not be checked", { late });
				const r: ExecutionResult = {
					...result,
					reason: EXECUTOR.reasons.verificationUnavailable,
					attempts,
				};
				if (late.reason !== undefined) r.error = late.reason;
				return r;
			}
			return { ...result, attempts };
		}
		const verdict = await o.verify(o.verifyTimeoutMs);
		if (verdict.outcome === "ok") return { ...result, attempts };
		if (verdict.outcome === "unavailable") return unavailable(result, attempts, verdict);
		log.warn("executor: move not verified", { tier, verdict });
		last = result;
	}
	const base = last as ExecutionResult;
	return { ...base, ok: false, outcome: "failed", reason: EXECUTOR.reasons.unverified, attempts };
}
