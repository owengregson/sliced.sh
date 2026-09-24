// test/fakes/maia-calibration.ts — pin the Maia strength calibration to the identity table.
//
// The selector and pipeline tests that call this exercise mechanics — the rails, the meters, the
// slider, the query rating — at the advertised rating with Maia's own distribution, as they were
// written before the calibration existed (2026-09-23). The calibration itself is pinned in
// test/core/strength/maia-calibration.test.ts. Each test file runs in its own process
// (scripts/test-runner.sh), so the mock never leaks into another file.
import { mock } from "bun:test";
import * as actual from "@core/constants/maia-calibration";

export function pinIdentityCalibration(): void {
	const real = { ...actual };
	mock.module("@core/constants/maia-calibration", () => ({
		...real,
		MAIA_CALIBRATION: real.MAIA_CALIBRATION_IDENTITY,
	}));
}
