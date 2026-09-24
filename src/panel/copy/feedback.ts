/** Transient feedback: toasts and banners. */

export const TOAST_COPY = {
	played: (san: string, seconds: string, method: string): string =>
		`Played ${san} · ${seconds}s · ${method}`,
	skipped: (san: string): string => `Skipped ${san} · auto-play stays on`,
	disarmed: (san: string): string => `Auto-play off · ${san} not played`,
	verifyFailed: (san: string): string => `Position mismatch after ${san}. Auto-play disabled.`,
	playFailed: "Move failed. Auto-play disabled.",
	keybind: (action: string, key: string): string => `${action} is now ${key}`,
	preArm: (key: string): string => `Turning on auto-play… press ${key} again to cancel`,
	reattached: "Auto-play back on",
	settingsSaved: "Settings saved",
	notVerified: "Move not verified — board differs from expected",
} as const;

export const BANNER_COPY = {
	detached: "Auto-play paused. Chrome's debugging session was closed.",
	reattach: "Reattach",
	dismiss: "Dismiss",
	failures: "Auto-play turned off after two failed moves. Check Engine for details.",
	openEngine: "Open Engine",
	engineStopped: "The engine stopped.",
	restartEngine: "Restart engine",
	update: (version: string): string => `sliced ${version} is ready`,
	updateAction: "Update",
	debugger: "Debugger attached. Cancel pauses auto-play.",
	gotIt: "Dismiss",
	handsOff: "Read-only during live play. Control auto-play with shortcuts.",
	focus: "Page focus unavailable. Auto-play paused.",
} as const;
