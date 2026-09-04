/**
 * Retry policy (§9.3, Appendix G §6): Tier 1 drag → Tier 2 click-click once
 * (or the reverse for a click-first hand), then report failure. Before every
 * retry the board is re-checked so a move that did land (slow verification)
 * is never played twice, and the retry waits `TIMINGS.executorRetryDelayMs`.
 * Skips, aborts and dispatch failures are final: they are position- or
 * user-level, not transport-level.
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
	/** Short board re-check before a retry (never double-move). */
	recheck(): Promise<VerifyResult>;
	delay(ms: number): Promise<void>;
	verifyTimeoutMs: number;
	signal?: AbortSignal;
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
		}
		const result = await o.attempt(tier, i);
		if (result.outcome !== "skipped") attempts += 1;
		if (!result.ok) return { ...result, attempts };
		const verdict = await o.verify(o.verifyTimeoutMs);
		if (verdict.outcome === "ok") return { ...result, attempts };
		log.warn("executor: move not verified", { tier, verdict });
		last = result;
	}
	const base = last as ExecutionResult;
	return { ...base, ok: false, outcome: "failed", reason: EXECUTOR.reasons.unverified, attempts };
}
