// test/service/move-executor/retry-policy.test.ts — Step 4: drag → click-click once, never double-move, no third attempt.
import { describe, expect, it } from "bun:test";
import { EXECUTOR, TIMINGS } from "@core/constants";
import type { ClickStyle, ExecutionResult } from "@core/motor/types";
import {
	otherTier,
	retryDelayMs,
	runWithRetry,
	tiersFor,
} from "@service/move-executor/retry-policy";
import type { VerifyResult } from "@service/move-executor/verifier";

const dispatched = (tier: ClickStyle): ExecutionResult => ({
	ok: true,
	outcome: "executed",
	tier,
	attempts: 1,
	endPoint: { x: 1, y: 1 },
	elapsedMs: 100,
	timeline: [],
});

interface Harness {
	attempts: ClickStyle[];
	verifies: number[];
	rechecks: number;
	delays: number[];
	/** Every fresh check controller handed out by `checkSignal()`, in order. */
	checks: AbortController[];
	/** Called when a check starts (lets a test abort that very check = a further cancel). */
	onCheck: (ac: AbortController) => void;
	run(style?: ClickStyle): Promise<ExecutionResult>;
}

const ABORTED_CHECK: VerifyResult = { outcome: "unavailable", reason: "aborted" };

function harness(
	verify: VerifyResult[],
	recheck: VerifyResult[] = [],
	attempt: (tier: ClickStyle, i: number) => ExecutionResult = dispatched,
	signal?: AbortSignal
): Harness {
	const h: Harness = {
		attempts: [],
		verifies: [],
		rechecks: 0,
		delays: [],
		checks: [],
		onCheck: () => {},
		run: (style = "drag") =>
			runWithRetry({
				style,
				attempt: async (tier, i) => {
					h.attempts.push(tier);
					return attempt(tier, i);
				},
				// both checks honour their signal: an aborted check never looks at the board
				verify: async (timeoutMs, sig) => {
					h.verifies.push(timeoutMs);
					h.onCheck(h.checks.at(-1) as AbortController);
					if (sig.aborted) return ABORTED_CHECK;
					return verify.shift() ?? { outcome: "timeout" };
				},
				recheck: async (sig) => {
					h.rechecks += 1;
					h.onCheck(h.checks.at(-1) as AbortController);
					if (sig.aborted) return ABORTED_CHECK;
					return recheck.shift() ?? { outcome: "rejected" };
				},
				checkSignal: () => {
					const ac = new AbortController();
					h.checks.push(ac);
					return ac.signal;
				},
				delay: async (ms) => {
					h.delays.push(ms);
				},
				verifyTimeoutMs: TIMINGS.executorVerifyTimeoutMs,
				...(signal ? { signal } : {}),
			}),
	};
	return h;
}

describe("retry policy tables", () => {
	it("drag retries as click-click and vice versa; at most maxAttempts tiers; delays from the registry", () => {
		expect(otherTier("drag")).toBe("click");
		expect(otherTier("click")).toBe("drag");
		expect(tiersFor("drag")).toEqual(["drag", "click"]);
		expect(tiersFor("click")).toEqual(["click", "drag"]);
		expect(tiersFor("drag")).toHaveLength(EXECUTOR.maxAttempts);
		expect(retryDelayMs(1)).toBe(TIMINGS.executorRetryDelayMs[0]);
		expect(retryDelayMs(99)).toBe(TIMINGS.executorRetryDelayMs.at(-1) as number);
	});
});

describe("runWithRetry", () => {
	it("a verified first attempt is executed with attempts = 1 and no retry", async () => {
		const h = harness([{ outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 1 });
		expect(h.attempts).toEqual(["drag"]);
		expect(h.verifies).toEqual([TIMINGS.executorVerifyTimeoutMs]);
		expect(h.rechecks).toBe(0);
		expect(h.delays).toEqual([]);
	});

	it("an unverified drag retries once as click-click after the registry delay, then fails — never a third attempt", async () => {
		const h = harness([{ outcome: "rejected", reason: "snapped back" }, { outcome: "timeout" }]);
		const r = await h.run();
		expect(r).toMatchObject({
			ok: false,
			outcome: "failed",
			reason: EXECUTOR.reasons.unverified,
			tier: "click",
			attempts: 2,
		});
		expect(h.attempts).toEqual(["drag", "click"]);
		expect(h.delays).toEqual([TIMINGS.executorRetryDelayMs[0]]);
		expect(h.rechecks).toBe(1);
		expect(h.verifies).toHaveLength(2);
	});

	it("re-checks the board before the retry: a move that already landed is reported without re-dispatch", async () => {
		const h = harness([{ outcome: "timeout" }], [{ outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 1 });
		expect(h.attempts).toEqual(["drag"]);
		expect(h.rechecks).toBe(1);
	});

	it("a click-first style retries as a drag", async () => {
		const h = harness([{ outcome: "rejected" }, { outcome: "ok" }]);
		const r = await h.run("click");
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 2 });
		expect(h.attempts).toEqual(["click", "drag"]);
	});

	it("skipped / aborted / failed attempts are returned as-is without verification or retry", async () => {
		for (const outcome of ["skipped", "aborted", "failed"] as const) {
			const h = harness([{ outcome: "ok" }], [], (tier) => ({
				...dispatched(tier),
				ok: false,
				outcome,
				reason: outcome,
			}));
			const r = await h.run();
			expect(r).toMatchObject({ ok: false, outcome, attempts: outcome === "skipped" ? 0 : 1 });
			expect(h.attempts).toEqual(["drag"]);
			expect(h.verifies).toEqual([]);
		}
	});

	it("an unavailable verification is terminal: failed with the registry reason and no second dispatch", async () => {
		const h = harness([{ outcome: "unavailable", reason: "no content port" }]);
		const r = await h.run();
		expect(r).toMatchObject({
			ok: false,
			outcome: "failed",
			reason: EXECUTOR.reasons.verificationUnavailable,
			error: "no content port",
			attempts: 1,
		});
		expect(h.attempts).toEqual(["drag"]);
		expect(h.rechecks).toBe(0);
	});

	it("an unavailable re-check before the retry is terminal too — never a dispatch on a guess", async () => {
		const h = harness(
			[{ outcome: "rejected" }],
			[{ outcome: "unavailable", reason: "disconnected" }]
		);
		const r = await h.run();
		expect(r).toMatchObject({
			ok: false,
			outcome: "failed",
			reason: EXECUTOR.reasons.verificationUnavailable,
			tier: "drag",
			attempts: 1,
		});
		expect(h.attempts).toEqual(["drag"]);
		expect(h.rechecks).toBe(1);
		expect(h.delays).toEqual([TIMINGS.executorRetryDelayMs[0]]);
	});

	it("an aborted or skipped attempt whose committed press went out gets one short re-check (attempts 1) and is upgraded — reason dropped — when the move landed", async () => {
		for (const outcome of ["aborted", "skipped"] as const) {
			const interrupted = (tier: ClickStyle): ExecutionResult => ({
				...dispatched(tier),
				ok: false,
				outcome,
				reason: outcome,
				pressed: true,
			});
			const landed = harness([], [{ outcome: "ok" }], interrupted);
			const up = await landed.run();
			expect(up).toMatchObject({ ok: true, outcome: "executed", attempts: 1 });
			expect(up.reason).toBeUndefined();
			expect(landed.rechecks).toBe(1);
			expect(landed.verifies).toEqual([]); // the short budget, never the full one
			expect(landed.attempts).toEqual(["drag"]);
			const missed = harness([], [{ outcome: "rejected" }], interrupted);
			expect(await missed.run()).toMatchObject({ ok: false, outcome, reason: outcome, attempts: 1 });
			expect(missed.attempts).toEqual(["drag"]);
			// unavailable: its own outcome/reason stand, `verification-unavailable` in error, no dispatch
			const dark = harness([], [{ outcome: "unavailable", reason: "no content port" }], interrupted);
			expect(await dark.run()).toMatchObject({
				ok: false,
				outcome,
				reason: outcome,
				pressed: true,
				error: EXECUTOR.reasons.verificationUnavailable,
				attempts: 1,
			});
			expect(dark.attempts).toEqual(["drag"]);
		}
	});

	it("the cancel that interrupted the attempt never poisons the re-check: it runs on a fresh signal and the board is looked at", async () => {
		const ac = new AbortController();
		const interrupted = (tier: ClickStyle): ExecutionResult => {
			ac.abort();
			return { ...dispatched(tier), ok: false, outcome: "aborted", reason: "aborted", pressed: true };
		};
		const landed = harness([], [{ outcome: "ok" }], interrupted, ac.signal);
		const up = await landed.run();
		expect(up).toMatchObject({ ok: true, outcome: "executed", pressed: true, attempts: 1 });
		expect(up.reason).toBeUndefined();
		expect(landed.rechecks).toBe(1);
		expect(landed.checks).toHaveLength(1);
		expect(landed.checks[0]?.signal.aborted).toBe(false);
		expect(landed.attempts).toEqual(["drag"]);
		const missed = harness([], [{ outcome: "rejected" }], interrupted, new AbortController().signal);
		expect(await missed.run()).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: "aborted",
			pressed: true,
			attempts: 1,
		});
		expect(missed.rechecks).toBe(1);
	});

	it("only a FURTHER cancel during the re-check aborts it: 'aborted' + pressed + verification-unavailable in error", async () => {
		const ac = new AbortController();
		const h = harness(
			[],
			[{ outcome: "ok" }],
			(tier) => {
				ac.abort();
				return { ...dispatched(tier), ok: false, outcome: "aborted", reason: "aborted", pressed: true };
			},
			ac.signal
		);
		h.onCheck = (check) => check.abort(); // the second cancel lands while the re-check is in flight
		const r = await h.run();
		expect(r).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: "aborted",
			pressed: true,
			error: EXECUTOR.reasons.verificationUnavailable,
			attempts: 1,
		});
		expect(h.rechecks).toBe(1);
		expect(h.attempts).toEqual(["drag"]);
	});

	it("a cancel during the post-drop rest bounds the verification (short budget, fresh signal) and never retries", async () => {
		const ac = new AbortController();
		const dropped = (tier: ClickStyle): ExecutionResult => {
			ac.abort(); // cancel arrives after the drop; the controller still reports the attempt ok
			return { ...dispatched(tier), pressed: true };
		};
		const ok = harness([{ outcome: "ok" }], [], dropped, ac.signal);
		expect(await ok.run()).toMatchObject({ ok: true, outcome: "executed", attempts: 1 });
		expect(ok.verifies).toEqual([EXECUTOR.recheckTimeoutMs]);
		expect(ok.checks[0]?.signal.aborted).toBe(false);
		const ac2 = new AbortController();
		const missed = harness(
			[{ outcome: "rejected" }],
			[],
			(tier) => {
				ac2.abort();
				return { ...dispatched(tier), pressed: true };
			},
			ac2.signal
		);
		expect(await missed.run()).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: "aborted",
			attempts: 1,
		});
		expect(missed.attempts).toEqual(["drag"]); // no click-click retry after a cancel
		expect(missed.rechecks).toBe(0);
		expect(missed.verifies).toEqual([EXECUTOR.recheckTimeoutMs]);
	});

	it("without a cancel the full verification budget is used and every check gets its own fresh signal", async () => {
		const h = harness([{ outcome: "rejected" }, { outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "click", attempts: 2 });
		expect(h.verifies).toEqual([TIMINGS.executorVerifyTimeoutMs, TIMINGS.executorVerifyTimeoutMs]);
		expect(h.checks).toHaveLength(3); // verify, pre-retry recheck, verify
		expect(h.checks.every((c) => !c.signal.aborted)).toBe(true);
	});

	it("an abort during the retry delay ends as aborted without dispatching again", async () => {
		const ac = new AbortController();
		const h = harness([{ outcome: "rejected" }], [], dispatched, ac.signal);
		const original = h.run;
		h.run = async () => {
			ac.abort();
			return original();
		};
		const r = await h.run();
		expect(r).toMatchObject({ ok: false, outcome: "aborted", attempts: 1 });
		expect(h.attempts).toEqual(["drag"]);
	});
});
