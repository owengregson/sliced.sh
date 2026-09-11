// test/service/move-executor/retry-policy.test.ts — Step 4: a drag, then one more drag, never a
// double-move, no third attempt. Click-to-move was removed end to end, so there is no "other
// tier": `runWithRetry` dispatches `EXECUTOR.maxAttempts` drags and nothing else.
import { describe, expect, it } from "bun:test";
import { EXECUTOR, TIMINGS } from "@core/constants";
import { POINTER_CONTROL } from "@core/constants/cdp";
import type { ExecutionResult } from "@core/motor/types";
import { retryDelayMs, runWithRetry } from "@service/move-executor/retry-policy";
import type { VerifyResult } from "@service/move-executor/verifier";

const dispatched = (): ExecutionResult => ({
	ok: true,
	outcome: "executed",
	tier: EXECUTOR.committedTier,
	attempts: 1,
	endPoint: { x: 1, y: 1 },
	elapsedMs: 100,
	timeline: [],
});

interface Harness {
	/** The index of every attempt `runWithRetry` dispatched, in order. */
	attempts: number[];
	verifies: number[];
	rechecks: number;
	delays: number[];
	/** Every fresh check controller handed out by `checkSignal()`, in order. */
	checks: AbortController[];
	/** Called when a check starts (lets a test abort that very check = a further cancel). */
	onCheck: (ac: AbortController) => void;
	run(): Promise<ExecutionResult>;
}

const ABORTED_CHECK: VerifyResult = { outcome: "unavailable", reason: "aborted" };

function harness(
	verify: VerifyResult[],
	recheck: VerifyResult[] = [],
	attempt: (i: number) => ExecutionResult = dispatched,
	signal?: AbortSignal
): Harness {
	const h: Harness = {
		attempts: [],
		verifies: [],
		rechecks: 0,
		delays: [],
		checks: [],
		onCheck: () => {},
		run: () =>
			runWithRetry({
				attempt: async (i) => {
					h.attempts.push(i);
					return attempt(i);
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
	it("the delay table covers every retry the registry allows and its last entry repeats", () => {
		expect(EXECUTOR.committedTier).toBe("drag");
		// one delay per retry (attempts after the first), and anything past the table repeats its end
		expect(TIMINGS.executorRetryDelayMs.length).toBeGreaterThanOrEqual(EXECUTOR.maxAttempts - 1);
		expect(retryDelayMs(1)).toBe(TIMINGS.executorRetryDelayMs[0]);
		expect(retryDelayMs(TIMINGS.executorRetryDelayMs.length)).toBe(
			TIMINGS.executorRetryDelayMs.at(-1) as number
		);
		expect(retryDelayMs(TIMINGS.executorRetryDelayMs.length + EXECUTOR.maxAttempts)).toBe(
			TIMINGS.executorRetryDelayMs.at(-1) as number
		);
	});
});

describe("runWithRetry", () => {
	it("checks the final rejected delivery and recognizes a move that landed without a third attempt", async () => {
		const h = harness([], [{ outcome: "rejected" }, { outcome: "ok" }], () => ({
			...dispatched(),
			ok: false,
			outcome: "failed",
			pressed: true,
			reason: EXECUTOR.reasons.dispatchFailed,
			error: POINTER_CONTROL.notDelivered,
		}));
		const result = await h.run();
		expect(result).toMatchObject({ ok: true, outcome: "executed", attempts: 2 });
		expect(result.error).toBeUndefined();
		expect(result.reason).toBeUndefined();
		expect(h.attempts).toEqual([0, 1]);
		expect(h.rechecks).toBe(2);
		expect(h.delays).toHaveLength(1);
	});

	it("ends an uncheckable final delivery as unavailable rather than guessing a third gesture", async () => {
		const h = harness(
			[],
			[{ outcome: "rejected" }, { outcome: "unavailable", reason: "page closed" }],
			() => ({
				...dispatched(),
				ok: false,
				outcome: "failed",
				pressed: true,
				reason: EXECUTOR.reasons.dispatchFailed,
				error: POINTER_CONTROL.notDelivered,
			})
		);
		expect(await h.run()).toMatchObject({
			ok: false,
			reason: EXECUTOR.reasons.verificationUnavailable,
			attempts: 2,
		});
		expect(h.attempts).toEqual([0, 1]);
		expect(h.rechecks).toBe(2);
	});

	it("recovers one rejected press with a new admission after checking the board", async () => {
		const rejected = () => ({
			...dispatched(),
			ok: false,
			outcome: "failed" as const,
			pressed: false,
			reason: EXECUTOR.reasons.dispatchFailed,
			error: POINTER_CONTROL.notDelivered,
		});
		const h = harness([{ outcome: "ok" }], [{ outcome: "rejected" }], (i) =>
			i === 0 ? rejected() : dispatched()
		);
		expect(await h.run()).toMatchObject({ ok: true, attempts: 2 });
		expect(h.rechecks).toBe(1);
		const alreadyLanded = harness([], [{ outcome: "ok" }], rejected);
		const landed = await alreadyLanded.run();
		expect(landed).toMatchObject({ ok: true, attempts: 1 });
		expect(landed.error).toBeUndefined();
		expect(landed.reason).toBeUndefined();
		expect(alreadyLanded.attempts).toEqual([0]);
		const persistent = harness([], [{ outcome: "rejected" }], rejected);
		expect(await persistent.run()).toMatchObject({
			ok: false,
			attempts: 2,
			error: POINTER_CONTROL.notDelivered,
		});
	});

	it("a verified first attempt is executed with attempts = 1 and no retry", async () => {
		const h = harness([{ outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 1 });
		expect(h.attempts).toEqual([0]);
		expect(h.verifies).toEqual([TIMINGS.executorVerifyTimeoutMs]);
		expect(h.rechecks).toBe(0);
		expect(h.delays).toEqual([]);
	});

	it("an unverified drag retries once as another drag after the registry delay, then fails — never a third attempt", async () => {
		const h = harness([{ outcome: "rejected", reason: "snapped back" }, { outcome: "timeout" }]);
		const r = await h.run();
		expect(r).toMatchObject({
			ok: false,
			outcome: "failed",
			reason: EXECUTOR.reasons.unverified,
			tier: "drag",
			attempts: 2,
		});
		// every dispatch the registry allows, and all of them drags: no click-click tier to fall back to
		expect(h.attempts).toEqual([...Array(EXECUTOR.maxAttempts).keys()]);
		expect(h.delays).toEqual([TIMINGS.executorRetryDelayMs[0]]);
		expect(h.rechecks).toBe(1);
		expect(h.verifies).toHaveLength(2);
	});

	it("re-checks the board before the retry: a move that already landed is reported without re-dispatch", async () => {
		const h = harness([{ outcome: "timeout" }], [{ outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 1 });
		expect(h.attempts).toEqual([0]);
		expect(h.rechecks).toBe(1);
	});

	it("the second attempt is a drag whose verification can still succeed", async () => {
		const h = harness([{ outcome: "rejected" }, { outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 2 });
		expect(h.attempts).toEqual([0, 1]);
	});

	it("skipped / aborted / failed attempts are returned as-is without verification or retry", async () => {
		for (const outcome of ["skipped", "aborted", "failed"] as const) {
			const h = harness([{ outcome: "ok" }], [], () => ({
				...dispatched(),
				ok: false,
				outcome,
				reason: outcome,
			}));
			const r = await h.run();
			expect(r).toMatchObject({ ok: false, outcome, attempts: outcome === "skipped" ? 0 : 1 });
			expect(h.attempts).toEqual([0]);
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
		expect(h.attempts).toEqual([0]);
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
		expect(h.attempts).toEqual([0]);
		expect(h.rechecks).toBe(1);
		expect(h.delays).toEqual([TIMINGS.executorRetryDelayMs[0]]);
	});

	it("an aborted or skipped attempt whose committed press went out gets one short re-check (attempts 1) and is upgraded — reason dropped — when the move landed", async () => {
		for (const outcome of ["aborted", "skipped"] as const) {
			const interrupted = (): ExecutionResult => ({
				...dispatched(),
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
			expect(landed.attempts).toEqual([0]);
			const missed = harness([], [{ outcome: "rejected" }], interrupted);
			expect(await missed.run()).toMatchObject({ ok: false, outcome, reason: outcome, attempts: 1 });
			expect(missed.attempts).toEqual([0]);
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
			expect(dark.attempts).toEqual([0]);
		}
	});

	it("a preview press that never became the committed one is still re-checked (§9.3a)", async () => {
		// `pressed` is the *committed* press. A §9.3a preview press is a real `mousedown` on a real
		// square and never sets it, so the board used to be reported on without ever being looked at
		// — and in the reflow ordering the escape release can land on a different square, i.e. submit
		// a move, which is exactly what the re-check exists to notice.
		const previewed = (): ExecutionResult => ({
			...dispatched(),
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.boardMoved,
			pressed: false,
			pressedAny: true,
		});
		const landed = harness([], [{ outcome: "ok" }], previewed);
		const up = await landed.run();
		expect(landed.rechecks).toBe(1);
		expect(up).toMatchObject({ ok: true, outcome: "executed" });
		const missed = harness([], [{ outcome: "rejected" }], previewed);
		expect(await missed.run()).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.boardMoved,
		});
		expect(missed.rechecks).toBe(1);

		// …and an attempt that dispatched nothing at all still returns without a board read.
		const nothing = (): ExecutionResult => ({
			...dispatched(),
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.boardMoved,
			pressed: false,
			pressedAny: false,
		});
		const untouched = harness([], [{ outcome: "ok" }], nothing);
		expect(await untouched.run()).toMatchObject({ ok: false, outcome: "aborted" });
		expect(untouched.rechecks).toBe(0);
	});

	it("the cancel that interrupted the attempt never poisons the re-check: it runs on a fresh signal and the board is looked at", async () => {
		const ac = new AbortController();
		const interrupted = (): ExecutionResult => {
			ac.abort();
			return { ...dispatched(), ok: false, outcome: "aborted", reason: "aborted", pressed: true };
		};
		const landed = harness([], [{ outcome: "ok" }], interrupted, ac.signal);
		const up = await landed.run();
		expect(up).toMatchObject({ ok: true, outcome: "executed", pressed: true, attempts: 1 });
		expect(up.reason).toBeUndefined();
		expect(landed.rechecks).toBe(1);
		expect(landed.checks).toHaveLength(1);
		expect(landed.checks[0]?.signal.aborted).toBe(false);
		expect(landed.attempts).toEqual([0]);
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
			() => {
				ac.abort();
				return { ...dispatched(), ok: false, outcome: "aborted", reason: "aborted", pressed: true };
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
		expect(h.attempts).toEqual([0]);
	});

	it("a cancel during the post-drop rest bounds the verification (short budget, fresh signal) and never retries", async () => {
		const ac = new AbortController();
		const dropped = (): ExecutionResult => {
			ac.abort(); // cancel arrives after the drop; the controller still reports the attempt ok
			return { ...dispatched(), pressed: true };
		};
		const ok = harness([{ outcome: "ok" }], [], dropped, ac.signal);
		expect(await ok.run()).toMatchObject({ ok: true, outcome: "executed", attempts: 1 });
		expect(ok.verifies).toEqual([EXECUTOR.recheckTimeoutMs]);
		expect(ok.checks[0]?.signal.aborted).toBe(false);
		const ac2 = new AbortController();
		const missed = harness(
			[{ outcome: "rejected" }],
			[],
			() => {
				ac2.abort();
				return { ...dispatched(), pressed: true };
			},
			ac2.signal
		);
		expect(await missed.run()).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: "aborted",
			attempts: 1,
		});
		expect(missed.attempts).toEqual([0]); // no second dispatch after a cancel
		expect(missed.rechecks).toBe(0);
		expect(missed.verifies).toEqual([EXECUTOR.recheckTimeoutMs]);
	});

	it("without a cancel the full verification budget is used and every check gets its own fresh signal", async () => {
		const h = harness([{ outcome: "rejected" }, { outcome: "ok" }]);
		const r = await h.run();
		expect(r).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 2 });
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
		expect(h.attempts).toEqual([0]);
	});
});
