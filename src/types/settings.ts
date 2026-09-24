/**
 * Settings and license types (§4.4) plus `DEFAULT_KEYBINDS` / `DEFAULT_SETTINGS`
 * — the ONLY definition of the defaults (`@core/constants/defaults` re-exports).
 *
 * The declarations live in `./settings/` (schema, defaults, license); this file is the entry
 * every importer uses.
 */

export { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from "./settings/defaults";
export type { LicenseState } from "./settings/license";
export type {
	Keybind,
	Keybinds,
	LogLevel,
	MoveQualityChipSide,
	PersonaId,
	Settings,
} from "./settings/schema";
