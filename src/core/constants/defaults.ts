/** Re-export of the settings defaults (§4.2); the definition lives in `@typedefs/settings`. */
export { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from "@typedefs/settings";

import type { EngineStatus } from "@typedefs/engine";

/** What the SW reports before the offscreen host has said anything (Task 12). */
export const DEFAULT_ENGINE_STATUS: Readonly<EngineStatus> = Object.freeze({
	state: "booting",
	variant: "smallnet",
	threads: 1,
	nnue: [],
	version: "",
});
