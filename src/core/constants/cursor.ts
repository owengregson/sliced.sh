/**
 * Where the pointer mirror sits in the page (2026-09-13). The arrow is a direct child of `<html>`
 * — not of `<body>`, whose `transform` / `filter` / `contain` would trap it in a stacking context
 * — at the largest `z-index` CSS allows, so the only page content that can paint over it is the
 * top layer (`<dialog>` / popover API), which no `z-index` reaches.
 */
export const CURSOR_LAYER = {
	/** The maximum `z-index` (INT32_MAX); the arrow is never below anything that uses one. */
	zIndex: 2_147_483_647,
	/** The trail and the no-popover shield fallback: one step under the arrow. */
	underlayZIndex: 2_147_483_646,
} as const;

/**
 * The unlock glide (2026-09-13): when the mirror goes from locked to unlocked — a `cursorHide`
 * from the worker, the page-kind gate, the port dropping — the arrow first glides from where it is
 * to the owner's real pointer, then the shield drops and the element goes. Drawing only: the
 * interpolated points go down the mirror's existing draw path and no input is dispatched.
 */
export const CURSOR_UNLOCK = {
	/** Length of the glide; skipped altogether when no real position is known. */
	glideMs: 320,
	/** Spacing of the interpolated points (one per frame at 60 Hz). */
	stepMs: 16,
} as const;

/** Artwork-only feedback. Geometry is in viewport CSS pixels. */
export const CURSOR_EFFECTS = {
	maxPoints: 12,
	trailLengthPx: 56,
	minDistancePx: 1,
	jumpDistancePx: 64,
	trailFadeMs: 200,
	/**
	 * Translucent copies of the cursor artwork that follow behind it, nearest first. `lag` is how
	 * many dispatched points behind the head each copy sits; a copy whose lag exceeds the buffer
	 * stays hidden rather than piling up on the tail.
	 */
	ghosts: [
		{ lag: 2, opacity: 0.38 },
		{ lag: 4, opacity: 0.24 },
		{ lag: 6, opacity: 0.12 },
	],
	ghostShadowBlurPx: 3,
	/** The copy's inner shape is the accent at this opacity over the accent body — a darker cut. */
	ghostInnerOpacity: 0.45,
	pressedScale: 0.94,
	pressDipScale: 0.91,
	releaseSettleScale: 1.015,
	contourWidthPx: 0.65,
	contourFillOpacity: 0.12,
	pressContourOpacity: 0.64,
	heldContourOpacity: 0.38,
	releaseContourOpacity: 0.58,
	pressMs: 125,
	releaseMs: 210,
	contourReleaseMs: 280,
	pressEasing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
	releaseEasing: "cubic-bezier(0.18, 0.65, 0.25, 1)",
} as const;
