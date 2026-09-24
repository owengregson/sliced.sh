/** Keybind capture, execution wording and account actions — shared by several views. */

export const KEYBIND_COPY = {
	capturing: "Press a key…",
	notSet: "Not set",
	conflict: (action: string): string =>
		`Already used for ${action} — press another key, or Enter to swap`,
	global: "Global shortcuts need Ctrl or Alt.",
	clear: "Clear",
	actions: {
		playMove: "Play move",
		toggleAutoMove: "Toggle auto-play",
		disable: "Disable assistant",
		speakMove: "Speak move",
	},
	keys: {
		space: "Space",
		enter: "Enter",
		escape: "Esc",
		backspace: "Backspace",
		delete: "Del",
		tab: "Tab",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
		ctrl: "Ctrl",
		alt: "Alt",
		shift: "Shift",
		meta: "Cmd",
		more: "…",
	},
} as const;

export const EXECUTION_COPY = {
	verify: "After each move, checks the board matches the expected position.",
	drag: "drag",
} as const;

export const ACCOUNT_COPY = {
	license: "License",
	plan: "Plan",
	device: "This device",
	signOut: "Sign out",
	signOutConfirm: "Sign out on this device? Your settings stay.",
	resetConfirm: "Reset all settings to defaults? Keybinds and strength included.",
	reset: "Reset",
	cancel: "Cancel",
	clearLog: "Clear log",
} as const;
