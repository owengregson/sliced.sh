/**
 * Canonical registry of every chrome.storage key the extension reads or writes.
 * Adding a new key? Add it here, not as a string literal in a feature module.
 */
export const LOCAL_KEYS = {
	settings: "sl::settings", // Settings (types/settings.ts)
	licenseState: "sl::license-state", // LicenseState
	licenseKey: "sl::license-key", // string
	updateAvailable: "sl::update-available", // boolean
	updateVersion: "sl::update-version", // string — the site's version when one is available
	engineNnueMeta: "sl::engine-nnue-meta", // { name, sha256, bytes, storedAt }
	sessionStats: "sl::session-stats", // SessionStats (games, moves, avgThinkMs)
	timingLog: "sl::timing-log", // ring buffer of TimingLogEntry (max 200)
	installedAt: "sl::installed-at", // number
	motorTraces: "sl::motor-traces", // MotorTrace chunks (Task 19), ≤ 20 MB total
	motorProfile: "sl::motor-profile", // fitted MotorProfile (Task 19)
} as const;

/** Cleared on service-worker restart — only ephemeral coordination flags. */
export const SESSION_KEYS = {
	autoMoveArmed: "sl::auto-move-armed", // Record<tabId, boolean>
	debuggerAttached: "sl::debugger-attached", // Record<tabId, boolean>
	personaByGame: "sl::persona-by-game", // Record<gameId, PersonaLatents>
} as const;

export type LocalKey = (typeof LOCAL_KEYS)[keyof typeof LOCAL_KEYS];
export type SessionKey = (typeof SESSION_KEYS)[keyof typeof SESSION_KEYS];

/** IndexedDB fallback for NNUE nets when OPFS is unavailable (offscreen `NnueStore`, Task 12). */
export const NNUE_DB = {
	name: "sl-nnue",
	store: "nets",
	version: 1,
} as const;

/** IndexedDB fallback for on-demand ChessMimic bands (offscreen `ModelStore`, Task 34). */
export const MODEL_DB = {
	name: "sl-models",
	store: "models",
	version: 1,
} as const;
