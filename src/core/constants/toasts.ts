/**
 * Port-toast registry (§4.3 `PanelPortMessage` `toast`): the service worker names the toast by
 * key, the panel renders `COPY.toast[key]` — user-facing copy never crosses into the SW bundle.
 */
export const TOAST_KEYS = {
	/** A move landed (`args: { san, elapsedMs }`; every move is a drag, so the panel names it). */
	played: "played",
	/** The executor could not verify the move on the board. */
	notVerified: "notVerified",
	/** The debugger re-attached and the hand is armed again. */
	reattached: "reattached",
} as const;

export type ToastKey = (typeof TOAST_KEYS)[keyof typeof TOAST_KEYS];
