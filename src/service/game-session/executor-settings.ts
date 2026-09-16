/**
 * The hand's controls as the executor runs them: `Settings.execution` re-based by
 * `SETTING_GAIN` (owner, 2026-09-13). This is the one place the two hand sliders turn into
 * `ExecutorGameConfig` values — the executor is constructed from it (`GameSessionRegistry`) and
 * updated from it (`GameSession.onSettingsChanged`), so the user's number is never read by the
 * executor directly.
 */

import { effectiveBaseSpeed, SETTING_GAIN } from "@core/constants/setting-gain";
import type { Settings } from "@typedefs/settings";

export interface ExecutorSettings {
	/**
	 * `execution.motorSpeed × SETTING_GAIN.motorSpeed × timing.baseSpeed`.
	 *
	 * The base-speed term is the 2026-09-15 half of the owner's instruction: the multiplier is on
	 * "literally time for the entire start to finish of making the move", and the hand's approach,
	 * drag, dwell and release are part of that move. It composes with the user's own Hand speed
	 * slider, and `boundedMotorSpeed` (`src/core/motor/motor-profile.ts`) clamps the product to
	 * the motor slider's range in effective units — 0.575×…2.3× — so no base speed can drive the
	 * pointer outside the band §13.2 measures. A hand at that ceiling still spends
	 * `EXECUTOR.minTravelMs` on its travel and keeps every press/settle floor.
	 */
	motorSpeed: number;
	/**
	 * `execution.previewSelectScale × SETTING_GAIN.previewSelectScale`; the slider's 0 is Off and
	 * stays exactly 0 (settings layout, 2026-09-13 — the former `previewSelects` segment).
	 */
	previewScale: number;
}

export function executorSettingsFor(
	execution: Settings["execution"],
	timing: Settings["timing"]
): ExecutorSettings {
	return {
		motorSpeed: execution.motorSpeed * SETTING_GAIN.motorSpeed * effectiveBaseSpeed(timing.baseSpeed),
		previewScale: Math.max(0, execution.previewSelectScale) * SETTING_GAIN.previewSelectScale,
	};
}
