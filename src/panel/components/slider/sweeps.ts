/**
 * A strength slider in its hot range launches its warm sweeps itself, so no change of cadence
 * ever re-times a sweep that is already crossing.
 *
 * This is the fix for the owner's 2026-09-15 report ("the animation timeskips when I let go of
 * the slider knob"): the cadence used to be the running CSS animation's *duration*, written on
 * release, and a running animation keeps its start time and re-maps elapsed time onto a new
 * duration — so every sweep jumped. Now a crossing in flight is never re-timed; a new cadence
 * takes effect at the next launch.
 */

import { sweepDelayMs } from "./model";

/** The two keyframe names a sweep alternates between (`css/views/live-progress.css`). */
const SWEEP_NAMES = ["a", "b"] as const;

export interface SweepLauncher {
	/** Sweeps run while `running`; leaving stops launching new ones. */
	sync(running: boolean): void;
}

export function createSweepLauncher(
	sweeps: readonly HTMLElement[],
	energy: () => number
): SweepLauncher {
	let sweepTimer: ReturnType<typeof setTimeout> | null = null;
	let sweepIndex = 0;

	/** Restart the next sweep's crossing (switching its keyframe name restarts it without a reflow). */
	function launchSweep(): void {
		const sweep = sweeps[sweepIndex % Math.max(1, sweeps.length)];
		sweepIndex += 1;
		if (sweep)
			sweep.dataset.sweep = sweep.dataset.sweep === SWEEP_NAMES[0] ? SWEEP_NAMES[1] : SWEEP_NAMES[0];
		sweepTimer = setTimeout(launchSweep, sweepDelayMs(energy(), sweeps.length));
	}

	return {
		sync(running) {
			if (running && sweeps.length > 0) {
				if (sweepTimer === null) launchSweep();
			} else if (sweepTimer !== null) {
				clearTimeout(sweepTimer);
				sweepTimer = null;
			}
		},
	};
}
