/**
 * Board effects (owner's brief, 2026-09-13) — the directional overlay drawn on the board for the
 * move that has just landed, whichever side played it. Gated by `Settings.automation.boardEffects`.
 *
 * This is the one definition of the effect vocabulary (C1). Three parties read it:
 *   - `src/core/chess/board-effects.ts` decides which effects a move produced (pure chess.js);
 *   - `src/service/game-session/board-effects.ts` sends them over the `sl-game` port;
 *   - `src/page/effects-overlay.ts` binds `BOARD_EFFECT_STYLES` / `BOARD_EFFECT_MOTION` /
 *     `BOARD_EFFECT_GEOMETRY` at build time and draws them in the MAIN world.
 *
 * The wire carries the one-letter `BOARD_EFFECT_KINDS` code, never the name: the page program is
 * scanned for product words (§13.3 rule 5) and a payload that spells "check" or "fork" out loud is
 * a DOM/traffic signature for no benefit. Colours are not on the wire either — the page picks them
 * from the bound palette with the `mine` flag, so a batch is a handful of squares and letters.
 */

import type { Square } from "@typedefs/game";

/**
 * Effect vocabulary, name → wire code. Every code is one character and unique; the page program
 * indexes `BOARD_EFFECT_STYLES` with it.
 */
export const BOARD_EFFECT_KINDS = {
	/** The moved piece now attacks an enemy piece it can win. */
	threat: "t",
	/** Two or more threats from the destination at once — drawn as a staggered fan. */
	fork: "k",
	/** The moved piece gives check: destination → enemy king. */
	check: "c",
	/** A piece the move uncovered now attacks something (a discovered check included). */
	discovery: "d",
	/** The move took a piece: the seize mark closing in on the captured square. */
	capture: "x",
	/** A pin or a skewer: attacker → front piece, and front piece → the piece behind it. */
	pin: "p",
	/** One slide trace of a castle (the king's, and the rook's). */
	castle: "s",
	/**
	 * The move promoted. Detected and sent, but drawn as nothing since the 2026-09-13 ring removal
	 * (its flourish was the three expanding pulses the owner asked to remove); the code is kept so
	 * the vocabulary and the wire stay stable, and a replacement flourish is the owner's call.
	 */
	promotion: "u",
	/** En passant: destination → the square the captured pawn actually stood on. */
	passant: "e",
} as const;

export type BoardEffectName = keyof typeof BOARD_EFFECT_KINDS;
export type BoardEffectCode = (typeof BOARD_EFFECT_KINDS)[BoardEffectName];

/** One directional effect: a ray from `from` to `to` (equal squares = an on-square flourish). */
export interface BoardEffect {
	kind: BoardEffectName;
	from: Square;
	to: Square;
}

/** Wire form of a `BoardEffect` (the letters are `BRIDGE_WIRE`'s). */
export interface BoardEffectWire {
	/** `BRIDGE_WIRE.effectKind` */
	n: BoardEffectCode;
	/** `BRIDGE_WIRE.from` */
	f: Square;
	/** `BRIDGE_WIRE.to` */
	t: Square;
}

/**
 * How each kind draws, in board units (1 = one square) and ms. Bound into the page program as one
 * JSON table, so the overlay holds no numbers of its own.
 *
 * - `scale` — the directional kinds are the recommendation arrow itself (`src/page/arrow-shape.ts`,
 *   emitted a second time in the effect layer at `BOARD_EFFECT_GEOMETRY.arrowScale`; owner,
 *   2026-09-13: "reuse the arrows from highlight move, but downscale them"), and `scale` is the
 *   per-kind multiplier on that, applied at draw time about the arrow's start so the tip still
 *   lands on the target. A check is drawn a little larger than a threat. `0` draws no arrow.
 * - `dash` — "dotted like before" (owner, 2026-09-13: "include making them dotted like they were
 *   before (a modified version of the highlight move arrow)"): the dot length of the arrow's shaft
 *   in board units at scale 1, `0` for the filled silhouette. It restores the earlier cut's
 *   pattern — the *line* kinds dotted (discovery 0.14, pin/skewer 0.09, castle 0.12) and the
 *   *strikes* solid (threat, fork, check, en passant) — drawn as the highlight arrow's own head
 *   plus a round-dotted shaft under the same gradient and shadow (`arrow-shape.ts`, the
 *   `dotGapRatio` option). The gap between dots is `dash × BOARD_EFFECT_GEOMETRY.dotGapRatio`,
 *   and both scale with the arrow (`arrowScale`, then the kind's `scale`).
 * - `seize` — the capture (2026-09-13, replacing the slash): a rounded-square outline in the
 *   mover's colour that starts larger than the captured square and contracts onto it, fading as it
 *   lands — the square being closed in on. Its numbers are `BOARD_EFFECT_SEIZE`.
 * - `delayMs` — multiplied by the effect's index in the batch, so a fan of forks unfurls.
 *
 * Every kind takes its side's one colour (owner, 2026-09-13: "make sure the enemy castle/discover
 * lines are also red like the take lines — and ours are blue", then "more pastel, less opacity" —
 * the pastel `effect.mine` / `effect.theirs` tokens at the a48 step): the soft/strong pairing and
 * the `strong` knob are gone, as are the pill knobs (`ray`, `head`, `width`) the arrow replaced.
 * The pulse rings were removed earlier the same day; a kind with neither an arrow nor a seize
 * mark draws nothing.
 */
export const BOARD_EFFECT_STYLES: Readonly<
	Record<
		BoardEffectCode,
		Readonly<{
			scale: number;
			dash: number;
			seize: 0 | 1;
			delayMs: number;
		}>
	>
> = {
	t: { scale: 0.85, dash: 0, seize: 0, delayMs: 0 },
	k: { scale: 0.95, dash: 0, seize: 0, delayMs: 90 },
	c: { scale: 1, dash: 0, seize: 0, delayMs: 0 },
	d: { scale: 0.9, dash: 0.14, seize: 0, delayMs: 0 },
	x: { scale: 0, dash: 0, seize: 1, delayMs: 0 },
	p: { scale: 0.8, dash: 0.09, seize: 0, delayMs: 0 },
	s: { scale: 0.8, dash: 0.12, seize: 0, delayMs: 0 },
	u: { scale: 0, dash: 0, seize: 0, delayMs: 0 },
	e: { scale: 0.85, dash: 0, seize: 0, delayMs: 0 },
};

/** Arrow shape, in board units. */
export const BOARD_EFFECT_GEOMETRY = {
	/**
	 * The highlight arrow, downscaled — owner 2026-09-13. Every length of the recommendation
	 * arrow's silhouette (`src/page/arrow-shape.ts`) is multiplied by this when the effect layer's
	 * copy is emitted; `BOARD_EFFECT_STYLES[kind].scale` sizes each kind on top of it.
	 */
	arrowScale: 0.6,
	/**
	 * A dotted shaft's gap between dots, as a multiple of the dot (`BOARD_EFFECT_STYLES[kind].dash`).
	 * Just over one dot, so the round-capped dots read as a beaded line rather than a dash.
	 */
	dotGapRatio: 1.1,
	/**
	 * Above the recommendation mark (`z-index: 3` on the highlight overlay) and far below the
	 * pointer mirror, which is a child of `<html>` at `CURSOR_LAYER.zIndex`.
	 */
	zIndex: 4,
} as const;

/**
 * The seize mark — the capture's drawing since 2026-09-13, replacing the slash (owner: "change
 * the take-piece animation (improve it, no longer do a slash — come up with another creative,
 * simple, minimalist animation for when taking pieces)"). A rounded-square outline, stroke only,
 * centred on the captured square: it starts at `from` × the square, contracts to `to` × over `ms`
 * with `BOARD_EFFECT_MOTION.easing`, and fades from the mover's colour to transparent as it lands.
 * Without motion it is drawn once at 1× and left for the next batch to replace. Captures stay
 * ray-free: nothing is drawn from the mover's origin.
 */
export const BOARD_EFFECT_SEIZE = {
	/** The outline's starting size, as a multiple of the square. */
	from: 1.12,
	/** Where it lands. */
	to: 0.86,
	/** The outline's corner radius, in board units. */
	radius: 0.12,
	/** The outline's stroke width, in board units. */
	width: 0.05,
	/**
	 * The contraction and fade, in ms. 390 since 2026-09-15 (owner: "slow down the capture piece
	 * animation by 50%" — 1.5× the earlier 260); still well inside the group's
	 * `BOARD_EFFECT_MOTION` life, so the mark lands before the group fades.
	 */
	ms: 390,
} as const;

/**
 * The game end (owner, 2026-09-15: "the last move of checkmate sequence isn't playing the sound
 * effect"). The page reports the game over in the same instant as its final position, and erasing
 * the layer at once cut that move's chip short and cancelled its sound. The layer is erased this long
 * after the game ends instead: past a chip's whole life (`MOVE_QUALITY` in + hold + out, 1 620 ms)
 * and the longest clip a last move can carry (`forced.mp3`, 1.368 s, at its lowest pitch of −12
 * semitones — half speed — 2.74 s). A new game, a navigation or the switch still erases at once.
 */
export const BOARD_EFFECT_GAME_END = {
	clearDelayMs: 3_000,
} as const;

/** One batch's motion. `drawMs + holdMs + fadeMs` is the life of an effect group. */
export const BOARD_EFFECT_MOTION = {
	drawMs: 260,
	holdMs: 380,
	fadeMs: 320,
	easing: "cubic-bezier(0.22, 0.68, 0.3, 1)",
} as const;

/**
 * Bounds on one batch, so a wild position cannot cover the board — and on the layer as a whole:
 * batches no longer replace one another (each group and each chip lives its own draw/hold/fade
 * and removes itself), so a burst of fast moves is capped by evicting the oldest first.
 */
export const BOARD_EFFECT_LIMITS = {
	/** Effects per move, in detection order (the most telling first). */
	maxEffects: 10,
	/** Threat rays from the destination square. */
	maxThreats: 4,
	/** Discovered attacks reported (the check is reported separately). */
	maxDiscoveries: 2,
	/** Pin/skewer chains reported. */
	maxPins: 2,
	/** Effect groups alive on the layer at once, across batches; the oldest is removed first. */
	maxLiveGroups: 24,
	/** Verdict chips alive at once; a new chip on a square also replaces the one already there. */
	maxLiveChips: 4,
} as const;
