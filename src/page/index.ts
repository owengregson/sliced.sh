// src/page/index.ts
/**
 * Page program registry (§5.5). `scripts/gen-pagescript.ts` compiles every
 * program listed here to `src/page/generated/<name>.ts` and, for `entry`
 * programs, to `dist/js/page/<name>.js` (the manifest's MAIN-world scripts).
 *
 * Every bind-time value comes from a registry (C1): selectors from
 * `SELECTORS`, colours from `TOKENS`, timings from `TIMINGS`, and the direction
 * tokens / overlay class from `deriveToken(seed, SPOOF_PURPOSES.*)` — the same
 * derivation `src/content/page-bridge-client.ts` performs at runtime with
 * `__SL_SPOOF_SEED__`.
 *
 * Delivery of the §5.5 `cursor-probe` (for Task 18, the executor): the
 * canonical path is the **bridge** — each bridge keeps the last trusted
 * pointer position in its closure and answers the `cursor` command; the
 * content script exposes it on the game port as `cursorProbe` →
 * `cursorProbeResult` (falling back to its own `CursorTracker`). The
 * `cursor-probe` program is only an explicit CDP fallback that returns `null`
 * at once (no marker on `window` ⇒ nothing to read synchronously); it never
 * waits.
 *
 * Build/test-time only: this module imports `@pagescript` and must never be
 * reached from a runtime bundle.
 */

import { FIGURINES } from "@content/adapters/move-list";
import { SELECTORS } from "@content/adapters/selectors";
import { BOARD_EFFECT_STYLES } from "@core/constants/board-effects";
import {
	MOVE_QUALITY_ART,
	MOVE_QUALITY_ICONS,
	MOVE_QUALITY_ORDER,
	MOVE_QUALITY as Q,
} from "@core/constants/move-quality";
import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { HIGHLIGHT_MOTION, TIMINGS } from "@core/constants/timings";
import { deriveToken } from "@core/spoof";
import { TOKENS } from "@design/tokens.generated";
import type { AnyPageProgram, EntryEnv } from "@pagescript";
import { chesscomBridge } from "./chesscom-bridge";
import { cursorProbe } from "./cursor-probe";
import { effectsOverlay } from "./effects-overlay";
import { focusProbe } from "./focus-probe";
import { highlightOverlay } from "./highlight-overlay";
import { verifyMoveProbe } from "./verify-move-probe";
import { virtualCursor } from "./virtual-cursor";

/** Overlay fallback colours (the adapter sends the themed ones in every `draw`). */
export const OVERLAY_COLORS = {
	from: TOKENS.color.dark.hlFrom,
	to: TOKENS.color.dark.hlTo,
	arrow: TOKENS.color.dark.hlArrow,
	edge: TOKENS.color.dark.canvas,
} as const;

/**
 * The board-effect palette (owner, 2026-09-13: "blue for your attacks and reddish for their
 * attacks", then "make sure the enemy castle/discover lines are also red like the take lines — and
 * ours are blue"): one opaque `effect.*-strong` token per side, every kind alike — the soft a64
 * steps read as a washed-out grey beside the capture and are no longer bound. `edge` tints the
 * arrow's shadow, as `OVERLAY_COLORS.edge` does for the recommendation mark. From `TOKENS` like
 * every other colour that reaches the page (C1/C4) — the board effects are not overridden by the
 * light theme, because they are painted on the host page, so one palette is the whole story. The
 * quality chip keeps its own per-category colours (`MOVE_QUALITY_ICONS`).
 */
export const EFFECT_COLORS = {
	mine: TOKENS.color.dark.effectMine,
	theirs: TOKENS.color.dark.effectTheirs,
	edge: TOKENS.color.dark.canvas,
} as const;

/** The two seed-derived direction tokens plus the inserted elements' classes (§13.3 rules 3, 5). */
export function bridgeTokens(env: EntryEnv): {
	token: string;
	peer: string;
	overlayClass: string;
	cursorClass: string;
	effectsClass: string;
	moveListClass: string;
} {
	return {
		token: deriveToken(env.seed, SPOOF_PURPOSES.pageToken),
		peer: deriveToken(env.seed, SPOOF_PURPOSES.contentToken),
		overlayClass: deriveToken(env.seed, SPOOF_PURPOSES.overlayClass),
		cursorClass: deriveToken(env.seed, SPOOF_PURPOSES.cursorClass),
		moveListClass: deriveToken(env.seed, SPOOF_PURPOSES.moveListClass),
		effectsClass: deriveToken(env.seed, SPOOF_PURPOSES.effectsClass),
	};
}

export const chesscomEntryArgs = (env: EntryEnv) => ({
	...bridgeTokens(env),
	boardTag: SELECTORS.boardTag,
	boardSelectors: [...SELECTORS.board],
	colors: OVERLAY_COLORS,
	retryMs: TIMINGS.bridgeRetryMs,
	retryMaxMs: TIMINGS.bridgeRetryMaxMs,
	cursorFadeMs: TIMINGS.virtualCursorFadeMs,
	cursorAccent: TOKENS.color.dark.brand,
	effectPalette: EFFECT_COLORS,
	effectStyles: BOARD_EFFECT_STYLES,
	qualityIcons: MOVE_QUALITY_ICONS,
	moveListConfig: {
		hosts: SELECTORS.moveList.join(","),
		nodes: SELECTORS.moveListAnnotationNodes,
		text: SELECTORS.moveText.join(","),
		nodeAttr: SELECTORS.moveListNodeAttr,
		offsetClass: SELECTORS.moveListOffsetClass,
		figurineAttr: SELECTORS.figurineAttr,
		figurines: FIGURINES,
		labels: MOVE_QUALITY_ORDER.map((name) => name[0]?.toUpperCase() + name.slice(1)),
		labelPrefix: "Bot: ",
		reducedMotion: HIGHLIGHT_MOTION.reducedMotionQuery,
		badgeFrames: [
			{ opacity: 0, transform: `scale(${Q.chipScaleFrom})`, offset: 0, easing: Q.chipEasing },
			{ opacity: Q.chipOpacity, transform: `scale(${Q.chipScalePeak})`, offset: Q.chipOvershootAt },
			{ opacity: Q.chipOpacity, transform: "scale(1)", offset: 1 },
		],
		badgeTiming: { duration: Q.chipInMs },
		textTiming: { duration: Q.chipInMs * Q.logTextInRatio, easing: Q.chipEasing },
		foreground: MOVE_QUALITY_ART.glyphFill,
		style: `display:inline-block;vertical-align:middle;margin-bottom:2.5px;margin-left:2px;margin-right:0px;pointer-events:none;flex-shrink:0;transform-origin:50% 50%;opacity:${Q.chipOpacity}`,
	},
});

export const programs: readonly AnyPageProgram[] = [
	{ ...chesscomBridge, entryArgs: chesscomEntryArgs },
	highlightOverlay,
	effectsOverlay,
	virtualCursor,
	cursorProbe,
	focusProbe,
	verifyMoveProbe,
];
