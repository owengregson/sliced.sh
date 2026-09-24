// test/fakes/timing-calibration.ts — pin the think-time calibration to the identity table.
//
// The session and executor tests that call this exercise mechanics — a queued premove's entry
// and settlement, a late search against a fixture head's sampled deadline, opponent pressure over
// a constant fixture sample — as they were written before the calibration existed (2026-09-24).
// Their heads are fixtures, not a learned distribution the table was fitted to. The calibration
// itself is pinned in test/core/timing/calibration.test.ts and, on real positions,
// calibration-replay.test.ts. Each test file runs in its own process (scripts/test-runner.sh), so
// the mock never leaks into another file.
import { mock } from "bun:test";
import * as actual from "@core/constants/timing-calibration";

export function pinIdentityTimingCalibration(): void {
	const real = { ...actual };
	mock.module("@core/constants/timing-calibration", () => ({
		...real,
		TIMING_CALIBRATION: real.TIMING_CALIBRATION_IDENTITY,
	}));
}
