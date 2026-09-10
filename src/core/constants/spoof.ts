/**
 * Purpose labels for `deriveToken(seed, purpose)` (`@core/spoof`). A page
 * program (build time, via `js.spoof` or a bound parameter) and the
 * ISOLATED-world content script (runtime) derive the same token from the
 * same purpose, so every purpose that crosses the MAIN/ISOLATED boundary is
 * registered here (C1).
 */
export const SPOOF_PURPOSES = {
	/** Property that tags `window.postMessage` envelopes between the bridge and the content script. */
	messageKey: "msgKey",
	/** Value of that property on envelopes posted by the MAIN-world bridge (page → content). */
	pageToken: "pageTok",
	/** Value of that property on envelopes posted by the content script (content → page). */
	contentToken: "contentTok",
	/** Class name of the highlight overlay `<svg>` the bridge inserts on `draw` (§13.3 rule 3). */
	overlayClass: "overlayCls",
} as const;

export type SpoofPurpose = (typeof SPOOF_PURPOSES)[keyof typeof SPOOF_PURPOSES];
