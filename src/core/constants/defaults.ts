/** Re-export of the settings defaults (§4.2); the definition lives in `@typedefs/settings`. */
export { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from "@typedefs/settings";

import type { EngineStatus } from "@typedefs/engine";
import type { Settings } from "@typedefs/settings";

/**
 * Settings the extension decides for the user (owner, 2026-09-12; settings layout, 2026-09-13).
 * They stay in `Settings` and `DEFAULT_SETTINGS`, and the code paths behind them are intact, but
 * the Settings view offers no control for them and `normalizeSettings` overwrites whatever is
 * stored with these values on every read — so a stale profile, an import or a test patch cannot
 * resurrect a removed option.
 *
 * This is the one definition: the normaliser applies it and the panel's `FORCED_SETTINGS` reason
 * table (`src/panel/views/settings/sections.ts`) is typed against it. Every value here equals its
 * `DEFAULT_SETTINGS` counterpart (`test/panel/views/settings.test.ts` checks).
 */
export const FORCED_SETTING_VALUES: Readonly<{
	strength: Readonly<Pick<Settings["strength"], "persona" | "selectionMode">>;
	timing: Readonly<Pick<Settings["timing"], "respectBudget">>;
	execution: Readonly<
		Pick<Settings["execution"], "calibrateFromMyMouse" | "backend" | "keepDebuggerAttached">
	>;
	keybinds: Readonly<Pick<Settings["keybinds"], "global">>;
	engine: Readonly<Pick<Settings["engine"], "nnue">>;
}> = Object.freeze({
	strength: Object.freeze({ persona: "balanced", selectionMode: "hybrid" }),
	timing: Object.freeze({ respectBudget: true }),
	execution: Object.freeze({
		calibrateFromMyMouse: false,
		backend: "cdp",
		keepDebuggerAttached: true,
	}),
	keybinds: Object.freeze({ global: false }),
	engine: Object.freeze({ nnue: "auto" }),
});

/** What the SW reports before the offscreen host has said anything (Task 12). */
export const DEFAULT_ENGINE_STATUS: Readonly<EngineStatus> = Object.freeze({
	state: "booting",
	variant: "smallnet",
	threads: 1,
	nnue: [],
	version: "",
});
