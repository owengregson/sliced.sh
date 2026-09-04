/**
 * Purpose labels for `deriveToken(seed, purpose)` (`@core/spoof`). A page
 * program (build time, via `js.spoof`) and the ISOLATED-world content script
 * (runtime) derive the same token from the same purpose, so every purpose
 * that crosses the MAIN/ISOLATED boundary is registered here (C1).
 */
export const SPOOF_PURPOSES = {
	/** Property that tags `window.postMessage` envelopes between the bridge and the content script. */
	messageKey: "msgKey",
} as const;

export type SpoofPurpose = (typeof SPOOF_PURPOSES)[keyof typeof SPOOF_PURPOSES];
