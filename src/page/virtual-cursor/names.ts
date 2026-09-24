// src/page/virtual-cursor/names.ts
/** The mirror's routine names and the pointer artwork's own geometry. */

import { CURSOR_EFFECTS, CURSOR_LAYER } from "@core/constants/cursor";

/** Function names shared by the bridge and standalone page program. */
export const CURSOR = {
	to: "curTo",
	hide: "curHide",
	prepare: "curPrepare",
	seal: "curSeal",
} as const;

/**
 * The graphic's own geometry — part of the artwork, not theme (the `--sl-*`
 * tokens do not resolve in the page realm, §13.3 / C3).
 */
export const CURSOR_ART = {
	/** Canvas size of the source SVG. */
	sizePx: 32,
	/** Arrow-tip hotspot inside that canvas; also the scale pivot. */
	hotX: 5,
	hotY: 5,
	/** Artwork compression; the input position stays fixed. */
	pressScale: CURSOR_EFFECTS.pressedScale,
	/**
	 * The maximum `z-index` there is (`CURSOR_LAYER`, 2026-09-13: "some popups go over it"). Nothing
	 * with a `z-index` can paint over the arrow; only the top layer can, and that is not a number.
	 */
	zIndex: CURSOR_LAYER.zIndex,
	/** The trail and the shield's no-popover fallback sit one step under the arrow. */
	underlayZIndex: CURSOR_LAYER.underlayZIndex,
	/** A CSS-pixel aperture, not a board-sized passthrough. */
	apertureRadiusPx: 1,
} as const;
