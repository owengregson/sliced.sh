/** chrome.runtime.connect port names for SW <-> page channels. */
export const PORT_NAMES = {
	panel: "sl-panel", // panel ↔ SW
	game: "sl-game", // content ↔ SW (one per tab)
	engine: "sl-engine", // offscreen ↔ SW
	logStream: "sl-log", // panel devtools log subscriber
} as const;

export type PortName = (typeof PORT_NAMES)[keyof typeof PORT_NAMES];
