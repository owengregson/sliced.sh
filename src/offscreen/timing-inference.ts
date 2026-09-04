/**
 * Timing-head inference host (§6.3 `timing-inference.ts`, §8.4) — SCAFFOLD.
 *
 * Task 34 implements the model (onnxruntime-web / hand-rolled head) behind
 * `handle`. Until then every `{kind:"timing"}` command is answered with
 * `{kind:"timing-result", probs: null, error: TIMING_NOT_AVAILABLE}` so the
 * service worker's timing planner falls back to its analytic model.
 */

import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";

export type TimingCommand = Extract<EnginePortCommand, { kind: "timing" }>;
export type TimingResultMessage = Extract<EnginePortMessage, { kind: "timing-result" }>;

export const TIMING_NOT_AVAILABLE = "not-available";

export interface TimingInference {
	handle(cmd: TimingCommand): TimingResultMessage;
	/** Releases the model (nothing to release in the scaffold). */
	dispose(): void;
}

export function createTimingInference(): TimingInference {
	return {
		handle(cmd) {
			return { kind: "timing-result", id: cmd.id, probs: null, error: TIMING_NOT_AVAILABLE };
		},
		dispose() {},
	};
}
