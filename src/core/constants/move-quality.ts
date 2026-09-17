/**
 * Move-quality chips (owner's brief, 2026-09-13) — the chess.com-style verdict badge drawn in the
 * bottom-left of the square a move landed on, for both sides' moves, while
 * `Settings.automation.moveQualityChips` is on — with or without `boardEffects` (2026-09-15).
 *
 * Three exports, deliberately separate top-level constants rather than one object: a bundler
 * inlines an object literal whole (the §13.3 lesson behind `LICENSE_ENDPOINT`), and only
 * `src/page/index.ts` — a build-time module — may carry the artwork. `MOVE_QUALITY` (the
 * thresholds) is what the service worker imports; `MOVE_QUALITY_ART` and `MOVE_QUALITY_ICONS` are
 * bound into the MAIN-world overlay at build time and never reach a runtime bundle.
 *
 * ── The category ladder (worst → best) ────────────────────────────────────────────────────────
 * Everything is measured from the point of view of the side that played the move, in lichess win
 * probability (`winProb(cpEffective(score))`, `@core/strength/elo-map`), because a centipawn is
 * worth far more at 0.00 than at +8.00 and a chip that calls a +9 → +6 move a blunder is wrong.
 *
 *   loss = winProb(best move's score) − winProb(the played move's score), clamped at 0
 *
 * The bands are decided in one pass, worst first, and then a *fine* move (loss below the
 * inaccuracy band) is upgraded along the ladder — each test can only move it up:
 *
 *   good → excellent (loss < `excellentMaxLoss`)
 *        → best      (the move is the engine's top line)
 *        → book      (still in the opening book)
 *        → great     (top line, and the runner-up is `greatGapWp` worse — the only move that held)
 *        → brilliant (great or best, and a sound sacrifice)
 *
 * `miss` is the one category that is not a band: a win or a mate was on the board and the move
 * did not take it. It outranks `mistake` and `inaccuracy` but never `blunder` — throwing the game
 * away is worse than failing to finish it.
 *
 * Mate handling rides on `cpEffective`, which maps mate-in-N to ±(1000 + (100 − |N|)) — so mate
 * for the mover is ≈ +1099 cp (win probability ≈ 0.98) and mate against ≈ −1099. A move that
 * walks from "mate in 3 available" into a drawn position therefore lands in the blunder band on
 * its own, and the `miss` test above catches the softer case where the position is still won.
 */

import type { Square } from "@typedefs/game";

/**
 * The twelve categories, worst → best. The wire carries the **index** into this array, never the
 * name (§13.3 rule 5: a payload that spells "blunder" is a traffic signature), and the overlay
 * indexes `MOVE_QUALITY_ICONS` with the same number. `mate` (owner, 2026-09-14) is every move of
 * a forced mating sequence, the checkmate included; `forced` (owner, 2026-09-15) is the only legal
 * move, played. Both are appended so no earlier index moves.
 */
export const MOVE_QUALITY_ORDER = [
	"blunder",
	"miss",
	"mistake",
	"inaccuracy",
	"good",
	"excellent",
	"best",
	"book",
	"great",
	"brilliant",
	"mate",
	"forced",
] as const;

export type MoveQuality = (typeof MOVE_QUALITY_ORDER)[number];

export interface MoveListRating {
	/** Zero-based ply in the game. */
	ply: number;
	san: string;
	quality: MoveQuality;
}

/** Wire index of a category (`-1` is impossible: the union is closed). */
export function moveQualityIndex(quality: MoveQuality): number {
	return MOVE_QUALITY_ORDER.indexOf(quality);
}

/** A verdict placed on a square. */
export interface MoveQualityMark {
	square: Square;
	quality: MoveQuality;
	/**
	 * `mate` only: the pitch the forced-mate sound plays at, in semitones from `forced.mp3` —
	 * `MOVE_QUALITY.mateMinSemitones` … `mateTopSemitones`, the checkmate on the top. A tangential
	 * move sits between two steps, so the value need not be whole.
	 */
	mateSemitones?: number;
}

export const MOVE_QUALITY = {
	/**
	 * The last `landedWindow` landed moves a rating may still post for, so a queued premove firing
	 * in the same instant as the reply (two plies in one position) or an instant reply does not
	 * orphan the opponent's rating.
	 */
	landedWindow: 2,
	/**
	 * The forced-mate sound's pitch (owner, 2026-09-15): "lean more heavily on our own pitch system
	 * (just use forced.mp3 without a number, don't swap between the sound files) as the base for the
	 * sound effect and use our own pitch to basically pitch down from a certain point (calculated
	 * based on the moves until mate) — if a move is made that is tangential to mate (so mate is still
	 * in a certain amount of moves) then we just play it slightly higher (average between current
	 * pitch semitones and the one that would have been played if you played the next in the mating
	 * sequence) — so basically going higher and higher pitch with each subsequent move until we
	 * reach mate (pitch = +3 semitones from base at the move that causes checkmate). Also make sure
	 * we play the sound on the checkmating move (the final one)."
	 *
	 * A move `mateIn` moves from checkmate (1 = the checkmate) sounds at
	 * `mateTopSemitones − (mateIn − 1) × mateSemitoneStep`, never below `mateMinSemitones`; a
	 * tangential move at the average of the mover's last pitch and the next step's
	 * (`mateSemitones`, `src/service/game-session/board-effects.ts`).
	 */
	mateTopSemitones: 3,
	mateSemitoneStep: 1,
	mateMinSemitones: -12,

	/**
	 * Chip geometry, in board units (1 = one square), anchored in the destination square. The size
	 * is the 2026-09-13 revision's three quarters of the first cut (0.46).
	 */
	chipSize: 0.345,
	chipAnchorX: 0.26,
	chipAnchorY: 0.74,

	/** Chip motion: scale/fade in, hold, fade out. */
	chipInMs: 200,
	/** Fraction of the entrance spent reaching its overshoot scale. */
	chipOvershootAt: 0.72,
	/** Move-log text fades at half its original speed (320 ms beside a 200 ms badge). */
	logTextInRatio: 1.6,
	chipHoldMs: 1_200,
	chipOutMs: 220,
	/** Opacity while held; the in/out ramps run between 0 and this. */
	chipOpacity: 0.8,
	chipScaleFrom: 0.55,
	chipScalePeak: 1.08,
	chipScaleOut: 0.88,
	chipEasing: "cubic-bezier(0.22, 0.68, 0.3, 1)",
} as const;

/**
 * Artwork shared by every chip (the owner's SVGs, 2026-09-13). The icons are 18×19 circles: a
 * shadow disc offset half a unit down, the category-coloured disc, the glyph's own shadow at the
 * same offset, and the white glyph.
 */
export const MOVE_QUALITY_ART = {
	viewBoxWidth: 18,
	viewBoxHeight: 19,
	/** Local centre of the disc, for the chip's scale transform origin. */
	originX: 9,
	originY: 9.5,
	circleShadow: "M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z",
	circleBackground: "M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z",
	glyphFill: "#FFFFFF",
	/** Both shadows are the panel canvas tone rather than pure black, so they sit on any board. */
	shadowFill: "#15181C",
	circleShadowOpacity: 0.3,
	glyphShadowOpacity: 0.2,
	/** The shadow copy of a glyph is the same paths, half a unit lower. */
	glyphShadowShift: 0.5,
} as const;

/**
 * Per-category disc colour and glyph paths, indexed by `MOVE_QUALITY_ORDER`. Transcribed from the
 * owner's SVGs, with the owner's corrected Miss background (#fb7766).
 */
export const MOVE_QUALITY_ICONS: ReadonlyArray<
	Readonly<{ background: string; glyph: readonly string[] }>
> = [
	{
		// blunder — "??"
		background: "#FA412D",
		glyph: [
			"M14.74,5A2.58,2.58,0,0,0,14,4a3.76,3.76,0,0,0-1.09-.56,4.07,4.07,0,0,0-1.2-.19,3.92,3.92,0,0,0-1.18.17,5.87,5.87,0,0,0-.9.37,3,3,0,0,0-.32.2,3.46,3.46,0,0,1,.42.63,3.29,3.29,0,0,1,.36,1.47.31.31,0,0,0,.19-.06L10.37,6a2.9,2.9,0,0,1,.29-.19,3.89,3.89,0,0,1,.41-.17,1.55,1.55,0,0,1,.48-.07,1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26.8.8,0,0,1,.07.34,1,1,0,0,1-.25.67,7.71,7.71,0,0,1-.65.63,6.2,6.2,0,0,0-.48.43,2.93,2.93,0,0,0-.45.54,2.55,2.55,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83v.35a.24.24,0,0,0,0,.12.35.35,0,0,0,.17.17l.12,0h1.71l.12,0a.23.23,0,0,0,.1-.07.21.21,0,0,0,.06-.1.27.27,0,0,0,0-.12V10.3a1,1,0,0,1,.26-.7q.27-.28.66-.63a5.79,5.79,0,0,0,.51-.48,4.51,4.51,0,0,0,.48-.6,2.56,2.56,0,0,0,.36-.72,2.81,2.81,0,0,0,.14-1A2.66,2.66,0,0,0,14.74,5Z",
			"M12.38,12.15H10.5l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0h1.88a.24.24,0,0,0,.12,0,.26.26,0,0,0,.11-.07.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V12.46a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,12.38,12.15Z",
			"M6.79,12.15H4.91l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0H6.79a.24.24,0,0,0,.12,0A.26.26,0,0,0,7,14.51a.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V12.46a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,6.79,12.15Z",
			"M8.39,4A3.76,3.76,0,0,0,7.3,3.48a4.07,4.07,0,0,0-1.2-.19,3.92,3.92,0,0,0-1.18.17,5.87,5.87,0,0,0-.9.37,3.37,3.37,0,0,0-.55.38l-.21.19a.32.32,0,0,0,0,.41l1,1.2a.26.26,0,0,0,.2.12.48.48,0,0,0,.24-.06L4.78,6a2.9,2.9,0,0,1,.29-.19l.4-.17A1.66,1.66,0,0,1,6,5.56a1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26A.77.77,0,0,1,7,6.4a1,1,0,0,1-.26.67,7.6,7.6,0,0,1-.64.63,6.28,6.28,0,0,0-.49.43,2.93,2.93,0,0,0-.45.54,2.72,2.72,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83v.35a.43.43,0,0,0,0,.12.39.39,0,0,0,.08.1.18.18,0,0,0,.1.07.21.21,0,0,0,.12,0H6.72l.12,0a.23.23,0,0,0,.1-.07.36.36,0,0,0,.07-.1.5.5,0,0,0,0-.12V10.3a1,1,0,0,1,.27-.7A8,8,0,0,1,8,9c.18-.15.35-.31.52-.48A7,7,0,0,0,9,7.89a3.23,3.23,0,0,0,.36-.72,3.07,3.07,0,0,0,.13-1A2.66,2.66,0,0,0,9.15,5,2.58,2.58,0,0,0,8.39,4Z",
		],
	},
	{
		// miss — a cross
		background: "#fb7766",
		glyph: [
			"M13.99,12.01s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-1.37,1.37s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-3.06-3.06-3.06,3.06s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-1.37-1.37c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l3.06-3.06-3.06-3.06c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l1.37-1.37c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l3.06,3.06,3.06-3.06c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l1.37,1.37s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-3.06,3.06,3.06,3.06Z",
		],
	},
	{
		// mistake — "?"
		background: "#FFA459",
		glyph: [
			"M9.92,14.52a.27.27,0,0,1,0,.12.41.41,0,0,1-.07.11.32.32,0,0,1-.23.09H7.7a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.69a.32.32,0,0,1,.09-.23l.1-.07.12,0H9.59a.32.32,0,0,1,.23.09.61.61,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6,6,6,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.24.24,0,0,1,0,.12.17.17,0,0,1-.06.1.3.3,0,0,1-.1.07l-.12,0H7.79l-.12,0a.3.3,0,0,1-.1-.07.26.26,0,0,1-.07-.1.37.37,0,0,1,0-.12v-.35a2.42,2.42,0,0,1,.13-.84,2.55,2.55,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.73,7.73,0,0,0,.64-.64,1,1,0,0,0,.26-.67.77.77,0,0,0-.07-.34A.75.75,0,0,0,9.48,6a1.16,1.16,0,0,0-.72-.24,1.61,1.61,0,0,0-.49.07A3,3,0,0,0,7.86,6a1.41,1.41,0,0,0-.29.18l-.11.09a.5.5,0,0,1-.24.06A.31.31,0,0,1,7,6.19L6,5a.29.29,0,0,1,0-.4,1.36,1.36,0,0,1,.21-.2A3.07,3.07,0,0,1,6.81,4a5.38,5.38,0,0,1,.89-.37,3.75,3.75,0,0,1,1.2-.17,4.07,4.07,0,0,1,1.2.19,4,4,0,0,1,1.09.56,2.76,2.76,0,0,1,.78.92,2.82,2.82,0,0,1,.28,1.28A3,3,0,0,1,12.12,7.35Z",
		],
	},
	{
		// inaccuracy — "?!"
		background: "#F7C631",
		glyph: [
			"M13.66,14.3a.28.28,0,0,1,0,.13.23.23,0,0,1-.08.11.28.28,0,0,1-.11.08l-.12,0h-2l-.13,0a.27.27,0,0,1-.1-.08A.36.36,0,0,1,11,14.3V12.4a.59.59,0,0,1,0-.13.36.36,0,0,1,.07-.1l.1-.08.13,0h2a.33.33,0,0,1,.23.1.39.39,0,0,1,.08.1.28.28,0,0,1,0,.13Zm-.12-3.93a.31.31,0,0,1,0,.13.3.3,0,0,1-.07.1.3.3,0,0,1-.23.08H11.43a.31.31,0,0,1-.34-.31L10.94,3.6A.5.5,0,0,1,11,3.36l.11-.08.13,0h2.11a.35.35,0,0,1,.26.1.41.41,0,0,1,.08.24Z",
			"M7.65,14.32a.27.27,0,0,1,0,.12.26.26,0,0,1-.07.11l-.1.07-.13,0H5.43a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.49a.36.36,0,0,1,.09-.23l.1-.07.12,0H7.32a.32.32,0,0,1,.23.09.3.3,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6A4.85,4.85,0,0,1,8.48,9a8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.21.21,0,0,1,0,.12.17.17,0,0,1-.06.1.23.23,0,0,1-.1.07l-.12,0H5.53a.21.21,0,0,1-.12,0,.18.18,0,0,1-.1-.07.2.2,0,0,1-.08-.1.37.37,0,0,1,0-.12v-.35a2.68,2.68,0,0,1,.13-.84,2.91,2.91,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.84,7.84,0,0,0,.65-.64,1,1,0,0,0,.25-.67.77.77,0,0,0-.07-.34.67.67,0,0,0-.23-.27,1.16,1.16,0,0,0-.72-.24A1.61,1.61,0,0,0,6,5.61a3,3,0,0,0-.41.18A1.75,1.75,0,0,0,5.3,6l-.11.09A.5.5,0,0,1,5,6.12.31.31,0,0,1,4.74,6l-1-1.21a.3.3,0,0,1,0-.4A1.36,1.36,0,0,1,4,4.18a3.07,3.07,0,0,1,.56-.38,5.49,5.49,0,0,1,.9-.37,3.69,3.69,0,0,1,1.19-.17A3.92,3.92,0,0,1,8.93,4a2.85,2.85,0,0,1,.77.92A2.82,2.82,0,0,1,10,6.21,3,3,0,0,1,9.85,7.15Z",
		],
	},
	{
		// good — a tick
		background: "#95B776",
		glyph: [
			"M15.11,6.31,9.45,12,7.79,13.63a.39.39,0,0,1-.28.11.39.39,0,0,1-.27-.11L2.89,9.28A.39.39,0,0,1,2.78,9a.39.39,0,0,1,.11-.27L4.28,7.35a.34.34,0,0,1,.12-.09l.15,0a.37.37,0,0,1,.15,0,.38.38,0,0,1,.13.09L7.52,10l5.65-5.65a.38.38,0,0,1,.13-.09.37.37,0,0,1,.15,0,.4.4,0,0,1,.15,0,.34.34,0,0,1,.12.09l1.39,1.38a.41.41,0,0,1,.08.13.33.33,0,0,1,0,.15.4.4,0,0,1,0,.15A.5.5,0,0,1,15.11,6.31Z",
		],
	},
	{
		// excellent — a thumb
		background: "#81B64C",
		glyph: [
			"M13.79,10.84c0-.2.4-.53.4-.94S14,9.22,14,9.08a2.06,2.06,0,0,0,.18-.83,1,1,0,0,0-.3-.69,1.13,1.13,0,0,0-.55-.2,10.29,10.29,0,0,1-2.07,0c-.37-.23,0-1.18.18-1.7s.51-2.12-.77-2.43c-.69-.17-.66.37-.78.9-.05.21-.09.43-.13.57A5,5,0,0,1,7.05,7.73a1.57,1.57,0,0,1-.42.18v4.94A7.23,7.23,0,0,1,8,13c.52.12.91.25,1.44.33a11.11,11.11,0,0,0,1.62.16,6.65,6.65,0,0,0,1.18,0,1.09,1.09,0,0,0,1-.59.66.66,0,0,0,.06-.2,1.63,1.63,0,0,1,.07-.3c.13-.28.37-.3.5-.68S13.74,11,13.79,10.84Z",
			"M5.49,7.59H4.31a.5.5,0,0,0-.5.5v4.56a.5.5,0,0,0,.5.5H5.49a.5.5,0,0,0,.5-.5V8.09A.5.5,0,0,0,5.49,7.59Z",
		],
	},
	{
		// best — a star
		background: "#81B64C",
		glyph: [
			"M9,2.93A.5.5,0,0,0,8.73,3a.46.46,0,0,0-.17.22L7.24,6.67l-3.68.19A.52.52,0,0,0,3.3,7a.53.53,0,0,0-.16.23.45.45,0,0,0,0,.28.44.44,0,0,0,.15.23L6.15,10l-1,3.56a.45.45,0,0,0,0,.28.46.46,0,0,0,.17.22.41.41,0,0,0,.26.09.43.43,0,0,0,.27-.08l3.09-2,3.09,2a.46.46,0,0,0,.53,0,.46.46,0,0,0,.17-.22.53.53,0,0,0,0-.28l-1-3.56L14.71,7.7a.44.44,0,0,0,.15-.23.45.45,0,0,0,0-.28A.53.53,0,0,0,14.7,7a.52.52,0,0,0-.26-.1l-3.68-.2L9.44,3.23A.46.46,0,0,0,9.27,3,.5.5,0,0,0,9,2.93Z",
		],
	},
	{
		// book — an open book
		background: "#D5A47D",
		glyph: [
			"M8.45,5.4c-1-.75-2.51-1.09-4.83-1.09H3V13h.58a8.09,8.09,0,0,1,4.83,1.17Z",
			"M9.54,14.19A8.14,8.14,0,0,1,14.38,13H15V4.31h-.58c-2.31,0-3.81.34-4.84,1.09Z",
		],
	},
	{
		// great — "!"
		background: "#749BBF",
		glyph: [
			"M10.32,14.1a.27.27,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0H8l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.2a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H8.1a.31.31,0,0,1-.34-.31L7.61,3.4a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0h2.11a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z",
		],
	},
	{
		// brilliant — "!!"
		background: "#26C2A3",
		glyph: [
			"M12.57,14.1a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0L10,14.34A.41.41,0,0,1,10,14.1V12.2A.32.32,0,0,1,10,12a.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H10.35a.31.31,0,0,1-.34-.31L9.86,3.4A.36.36,0,0,1,10,3.16a.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H12.3a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z",
			"M8.07,14.1a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.2a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2A.31.31,0,0,1,8,12a.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13ZM8,10.17a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H5.85a.31.31,0,0,1-.34-.31L5.36,3.4a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H7.8a.35.35,0,0,1,.25.1.36.36,0,0,1,.09.24Z",
		],
	},
	{
		// mate — a star (owner's SVG, 2026-09-14). The source draws the glyph inside a
		// `scale(1.125)` group; the coordinates here have that scale applied, so the overlay needs
		// no per-icon transform.
		background: "#E3AA24",
		glyph: [
			"M5.9096 14.0781C5.5301 14.3311 5.0783 14.0058 5.2048 13.5721L6.1445 10.0119L3.2891 7.6986C2.9096 7.3914 3.2168 6.8854 3.5602 6.8492L7.2469 6.6504L8.5662 3.2167C8.6385 3.036 8.8192 2.9095 9.018 2.9095C9.1987 2.9095 9.3795 3.0179 9.4518 3.2167L10.771 6.6504L14.4397 6.8492C14.9096 6.8673 15.0181 7.4456 14.7108 7.6805L11.8554 10.0119L12.7951 13.5721C12.9216 14.0239 12.3975 14.2769 12.0903 14.0781L8.9999 12.0902L5.9096 14.0781Z",
		],
	},
	{
		// forced — an arrow (owner's SVG, 2026-09-15): the only legal move was played.
		background: "#96AF8B",
		glyph: [
			"M14.39,8.57,9,3.81a.31.31,0,0,0-.3,0,.32.32,0,0,0-.13.1A.29.29,0,0,0,8.5,4V6.92H3.9a.58.58,0,0,0-.19,0,.5.5,0,0,0-.17.11.91.91,0,0,0-.11.16.63.63,0,0,0,0,.19v3.41a.58.58,0,0,0,0,.19.64.64,0,0,0,.11.16.39.39,0,0,0,.17.11.41.41,0,0,0,.19,0H8.5v2.74a.26.26,0,0,0,.16.26.3.3,0,0,0,.16,0A.34.34,0,0,0,9,14.29l5.42-4.76a.69.69,0,0,0,.16-.22.7.7,0,0,0,0-.52A.69.69,0,0,0,14.39,8.57Z",
		],
	},
];
