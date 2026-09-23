/**
 * The one command vocabulary the panel, the in-page keybinds and `chrome.commands` all funnel
 * into, and the two name tables that map onto it.
 */

/** Commands the panel, the keybinds and `chrome.commands` all funnel into. */
export type SessionCommand =
	| "playNow"
	| "armAutoMove"
	| "toggleAutoMove"
	| "disarm"
	| "disable"
	| "speakMove";

/** Manifest `commands` names → session commands. */
export const COMMAND_NAMES = {
	playBestMove: "play-best-move",
	toggleAutoMove: "toggle-auto-move",
	disableAssistant: "disable-assistant",
} as const;

const COMMAND_MAP: Readonly<Record<string, SessionCommand>> = {
	[COMMAND_NAMES.playBestMove]: "playNow",
	[COMMAND_NAMES.toggleAutoMove]: "toggleAutoMove",
	[COMMAND_NAMES.disableAssistant]: "disable",
};

/** In-page keybind actions (`Keybinds` minus `global`) → session commands. */
const KEYBIND_MAP: Readonly<Record<string, SessionCommand>> = {
	playMove: "playNow",
	toggleAutoMove: "toggleAutoMove",
	disable: "disable",
	speakMove: "speakMove",
};

/** The session command a manifest `commands` name stands for, if any. */
export function commandForShortcut(command: string): SessionCommand | undefined {
	return COMMAND_MAP[command];
}

/** The session command an in-page keybind action stands for, if any. */
export function commandForKeybind(action: string): SessionCommand | undefined {
	return KEYBIND_MAP[action];
}
