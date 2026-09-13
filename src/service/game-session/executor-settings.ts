/**
 * The hand's controls as the executor runs them: `Settings.execution` re-based by
 * `SETTING_GAIN` (owner, 2026-09-13). This is the one place the two hand sliders turn into
 * `ExecutorGameConfig` values — the executor is constructed from it (`GameSessionRegistry`) and
 * updated from it (`GameSession.onSettingsChanged`), so the user's number is never read by the
 * executor directly.
 */

import { SETTING_GAIN } from "@core/constants/setting-gain";
import type { Settings } from "@typedefs/settings";

export interface ExecutorSettings {
	/** `execution.motorSpeed × SETTING_GAIN.motorSpeed`. */
	motorSpeed: number;
	/**
	 * `execution.previewSelectScale × SETTING_GAIN.previewSelectScale`; the slider's 0 is Off and
	 * stays exactly 0 (settings layout, 2026-09-13 — the former `previewSelects` segment).
	 */
	previewScale: number;
}

export function executorSettingsFor(execution: Settings["execution"]): ExecutorSettings {
	return {
		motorSpeed: execution.motorSpeed * SETTING_GAIN.motorSpeed,
		previewScale: Math.max(0, execution.previewSelectScale) * SETTING_GAIN.previewSelectScale,
	};
}
