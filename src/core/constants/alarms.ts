/**
 * Names + cadences for chrome.alarms entries. Cadences are in MINUTES per the
 * Chrome API; convert at the call site if ms are needed.
 */
export const ALARM_NAMES = {
	licenseRevalidate: "sl-license",
	keepalive: "sl-keepalive",
	timingLogFlush: "sl-timing-flush",
} as const;
export const ALARM_CADENCE_MINUTES = {
	licenseRevalidate: 360,
	keepalive: 0.5,
	timingLogFlush: 5,
} as const;

export type AlarmName = (typeof ALARM_NAMES)[keyof typeof ALARM_NAMES];

/**
 * `Keepalive.hold` reasons owned outside the debugger manager
 * (`DEBUGGER_KEEPALIVE_REASON` in `@core/constants/cdp` is the other one).
 * `game` is held by the session registry while any tab is live (§3.3).
 */
export const KEEPALIVE_REASONS = {
	game: "game",
} as const;
