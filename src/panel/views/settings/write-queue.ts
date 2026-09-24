/**
 * Settings writes, serialised: each patch waits for the previous one, the save status reads
 * Saving… / Saved / Save failed, and a failed write restores the stored values. A patch that moves
 * one end of a min/max pair past the other drags the other end with it.
 */

import { log } from "@core/logger";
import type { SettingsPatch } from "@core/storage/settings-storage";
import type { Settings } from "@typedefs/settings";
import { COPY } from "../../copy";

/** The min/max pairs a patch keeps ordered. */
const RANGE_PAIRS = [
	["autoQueueSessionMinMinutes", "autoQueueSessionMaxMinutes"],
	["autoQueueBreakMinMinutes", "autoQueueBreakMaxMinutes"],
] as const;

/**
 * The patch as written: when it sets one end of a pair alone and crosses the stored other end,
 * the other end follows (a copy — the caller's patch is untouched).
 */
export function orderedRangePatch(patch: SettingsPatch, current: Settings): SettingsPatch {
	const automation = patch.automation ? { ...patch.automation } : undefined;
	if (!automation) return patch;
	for (const [lo, hi] of RANGE_PAIRS) {
		const min = automation[lo];
		const max = automation[hi];
		if (min !== undefined && max === undefined && min > current.automation[hi]) automation[hi] = min;
		if (max !== undefined && min === undefined && max < current.automation[lo]) automation[lo] = max;
	}
	return { ...patch, automation };
}

export interface WriteQueueDeps {
	save(patch: SettingsPatch): Promise<Settings>;
	signal: AbortSignal;
	locked(): boolean;
	current(): Settings;
	/** The stored result of a write. */
	onSaved(next: Settings): void;
	/** A write failed: re-render the (unchanged) stored values. */
	onFailed(): void;
	/** The save status line. */
	status: HTMLElement;
}

export function createWriteQueue(deps: WriteQueueDeps): (patch: SettingsPatch) => void {
	const { signal, status } = deps;
	let queue: Promise<void> = Promise.resolve();
	let pendingWrites = 0;
	let writeFailed = false;

	return function write(patch: SettingsPatch): void {
		if (deps.locked() || signal.aborted) return;
		if (pendingWrites === 0) writeFailed = false;
		pendingWrites += 1;
		status.textContent = COPY.workspace.saving;
		status.dataset.state = "saving";
		queue = queue
			.then(async () => {
				if (deps.locked() || signal.aborted) return;
				const next = await deps.save(orderedRangePatch(patch, deps.current()));
				if (signal.aborted) return;
				deps.onSaved(next);
			})
			.catch((error: unknown) => {
				log.warn("settings: write failed", error);
				if (signal.aborted) return;
				deps.onFailed();
				writeFailed = true;
			})
			.finally(() => {
				pendingWrites -= 1;
				if (signal.aborted || pendingWrites > 0) return;
				status.textContent = writeFailed ? COPY.workspace.saveFailed : COPY.workspace.saved;
				status.dataset.state = writeFailed ? "error" : "saved";
			});
	};
}
