// src/page/effects-overlay.ts
/**
 * `effects-overlay` (§5.5, §13.3): the board-effect layer — directional arrows for what the move
 * that just landed did (the recommendation arrow's own silhouette, downscaled, the line kinds with
 * a dotted shaft — `arrow-shape.ts`), the seize mark on a captured square, plus the verdict chip
 * on the destination square.
 *
 * Presence rules (§13.3 rule 3): nothing is inserted until an `effects` command arrives; the one
 * `<svg viewBox="0 0 8 8">` it appends to the board host is `pointer-events: none`; it is
 * idempotent by looking its own per-build class up in the DOM (no `window` property); its root
 * carries no `id`, `data-*` or text. It is a *separate* element from the recommendation mark, one
 * step above it in the stacking order, so the two have independent lifetimes and neither clear
 * touches the other.
 *
 * Every number, colour and path here is bound at build time from a registry (C1): the style table
 * and geometry from `@core/constants/board-effects`, the chip artwork from
 * `@core/constants/move-quality`, the palette from `TOKENS` through `src/page/index.ts`. The wire
 * carries one letter per kind and one index per verdict, so nothing page-visible spells a chess
 * idea out loud (§13.3 rule 5).
 *
 * `effectsStatements` is the reusable builder the bridge embeds; the standalone program below is
 * the same layer driven by its own message listener (non-entry: generated as a module only).
 */

import { BOARD_EFFECT_GEOMETRY as G } from "@core/constants/board-effects";
import { defineProgram, type Expression, js, type Statement } from "@pagescript";
import { arrowShapeStatements } from "./arrow-shape";
import { defineHandle, definePost, KINDS, listen, post } from "./bridge-common";
import { badgeRoutine } from "./effects-overlay/badge";
import { clearRoutine, drawRoutine } from "./effects-overlay/batch";
import { bookkeepingRoutines, bookkeepingState } from "./effects-overlay/bookkeeping";
import { arrowColors, markRoutines } from "./effects-overlay/marks";
import { EFFECTS, type EffectsParams } from "./effects-overlay/names";
import { id } from "./parts/ast";
import { hostLadder, layerEnsure, layerFind, squareCell } from "./parts/layer";

export { EFFECTS, type EffectsParams } from "./effects-overlay/names";

const OVERLAY_STYLE = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${G.zIndex}`;

/**
 * Declares, inside the enclosing closure:
 *   `efDraw(q)`  — draw a batch from `{ r, u, z: [{n, f, t}], b?: {q, j} }`
 *   `efClear()`  — fade the layer out and remove it
 *
 * Lifecycles (2026-09-13 revision): a batch does not replace the one before it. Every effect
 * group and every chip is an entry `{ node, anims }` in `efLive` / `efChips`, animates in, holds,
 * fades and removes itself; a new batch only *adds*. The lists exist for two things — the caps
 * (`BOARD_EFFECT_LIMITS.maxLiveGroups` / `maxLiveChips`, oldest evicted first) and the static
 * path (no motion: nothing removes itself, so the next batch replaces the layer as it always did).
 * Only `efClear` wipes the layer.
 */
export function effectsStatements(p: EffectsParams): Statement[] {
	return [
		...bookkeepingState(),
		...bookkeepingRoutines(),
		hostLadder("efHost", p.hosts, "selector"),
		layerFind("efFind", "efHost", p.cls),
		layerEnsure("efEnsure", { find: "efFind", host: "efHost" }, p.cls, OVERLAY_STYLE),
		squareCell("efCell"),
		arrowColors(p),
		...arrowShapeStatements({
			cls: p.cls,
			colors: id("efArrowColors"),
			prefix: "ef",
			cell: "efCell",
			animate: "efAnimate",
			scale: G.arrowScale,
			sizeArg: true,
			dotGapRatio: G.dotGapRatio,
		}),
		...markRoutines(p),
		badgeRoutine(p),
		drawRoutine(p),
		clearRoutine(p),
	];
}

/** Draw returns whether a new badge was inserted; clear removes the layer. */
export const effects = {
	draw: (payload: Expression): Expression => js.call(id(EFFECTS.draw), payload),
	clear: (): Statement => js.expr(js.call(id(EFFECTS.clear))),
};

/**
 * Standalone layer program: listens for `effects` / `effectsClear` from the content script and
 * answers each with its id. Parameters are bound by the caller (`token` / `peer` are the
 * seed-derived direction tokens).
 */
export const effectsOverlay = defineProgram({
	name: "effects-overlay",
	params: {
		token: "string",
		peer: "string",
		hosts: "json",
		cls: "string",
		palette: "json",
		styles: "json",
		icons: "json",
	},
	build: (p) =>
		js.program([
			definePost(p.token),
			...effectsStatements({
				hosts: p.hosts,
				cls: p.cls,
				palette: p.palette,
				styles: p.styles,
				icons: p.icons,
			}),
			defineHandle([
				{
					kind: KINDS.effects,
					body: [post(KINDS.effects, id("i"), effects.draw(id("q")))],
				},
				{
					kind: KINDS.effectsClear,
					body: [effects.clear(), post(KINDS.effectsClear, id("i"), js.nil())],
				},
			]),
			listen(p.peer),
		]),
});
