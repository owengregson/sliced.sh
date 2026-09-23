// src/page/effects-overlay/batch.ts
/**
 * `efDraw(q)` draws a wire batch `{ r, u, z: [{n, f, t}], b?: {q, j} }` onto the layer and
 * `efClear()` fades the layer out. A batch does not replace the one before it: it only *adds*
 * (`bookkeeping.ts`); only `efClear` wipes the layer.
 */

import { BRIDGE_ORIENTATION, BRIDGE_WIRE as W } from "@core/constants/bridge";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { js, type Statement } from "@pagescript";
import { orEmpty } from "../bridge-common";
import { add, callm, id, mul, n, s } from "../parts/ast";
import { fadeOutLayer } from "../parts/layer";
import { canAnimate } from "../parts/motion";
import { CHIPS as chips, flush, LIVE as live } from "./bookkeeping";
import { EFFECTS, type EffectsParams } from "./names";

/** `typeof el.animate === "function" && !matchMedia(reduced).matches` */
const motionTest = (el: ReturnType<typeof id>) =>
	canAnimate(el, s(HIGHLIGHT_MOTION.reducedMotionQuery));

export function drawRoutine(p: Pick<EffectsParams, "styles">): Statement {
	const el = id("el");
	const black = id("black");
	const st = id("st");

	// A batch adds to the layer; it never replaces what is still animating. The rays are drawn
	// once per distinct batch (the verdict command repeats the list beside the chip, and a
	// republished position repeats it entirely), and the chip once per distinct verdict — keyed
	// with `mine` so a recapture's chip on the same square with the same verdict still shows.
	// Without motion nothing removes itself, so the next distinct batch replaces the layer.
	return js.const_(
		EFFECTS.draw,
		js.arrow(
			["q"],
			[
				js.const_("el", js.call(id("efEnsure"))),
				js.if_(js.not(el), [js.ret(js.bool(false))]),
				js.const_(
					"black",
					js.op(js.member(id("q"), W.orientation), "===", s(BRIDGE_ORIENTATION.black))
				),
				js.const_("motion", motionTest(el)),
				js.const_("list", orEmpty(js.member(id("q"), W.effectList))),
				js.const_(
					"mark",
					callm(
						id("JSON"),
						"stringify",
						js.arr(js.member(id("q"), W.orientation), id("list"), js.member(id("q"), W.mine))
					)
				),
				// A fresh layer (after a clear, or the host was replaced): nothing from the old one
				// is on it, so the bookkeeping starts over.
				js.if_(js.op(id("efElement"), "!==", el), [
					js.assign(id("efElement"), el),
					js.assign(js.member(live, "length"), n(0)),
					js.assign(js.member(chips, "length"), n(0)),
					js.assign(id("efMark"), js.nil()),
					js.assign(id("efChipMark"), js.nil()),
				]),
				// A badge-only delivery must not replace the ray batch (including reduced motion).
				js.if_(
					js.and(
						js.or(js.member(id("list"), "length"), js.not(js.member(id("q"), W.badge))),
						js.op(id("efMark"), "!==", id("mark"))
					),
					[
						js.assign(id("efMark"), id("mark")),
						js.if_(js.not(id("motion")), [
							flush(live),
							flush(chips),
							js.assign(id("efChipMark"), js.nil()),
						]),
						js.let_("prev", js.nil()),
						js.let_("run", n(0)),
						js.forOf("e", id("list"), [
							js.if_(
								js.op(js.member(id("e"), W.effectKind), "===", id("prev")),
								[js.assign(id("run"), add(id("run"), n(1)))],
								[js.assign(id("prev"), js.member(id("e"), W.effectKind)), js.assign(id("run"), n(0))]
							),
							js.const_("st", js.member(p.styles, js.member(id("e"), W.effectKind))),
							js.expr(
								js.call(
									id("efEffect"),
									el,
									id("e"),
									black,
									js.member(id("q"), W.mine),
									id("motion"),
									js.cond(st, mul(js.member(st, "delayMs"), id("run")), n(0))
								)
							),
						]),
					]
				),
				js.const_("chip", js.member(id("q"), W.badge)),
				js.if_(id("chip"), [
					js.const_(
						"badge",
						callm(
							id("JSON"),
							"stringify",
							js.arr(js.member(id("q"), W.orientation), js.member(id("q"), W.mine), id("chip"))
						)
					),
					js.if_(js.op(id("efChipMark"), "!==", id("badge")), [
						js.assign(id("efChipMark"), id("badge")),
						js.ret(js.call(id("efBadge"), el, id("chip"), black, id("motion"))),
					]),
				]),
				js.ret(js.bool(false)),
			]
		)
	);
}

export function clearRoutine(p: Pick<EffectsParams, "cls">): Statement {
	// A clear fades the layer out rather than snapping it away, exactly as the recommendation mark
	// does: the element is first renamed out of `efFind`'s reach — so a batch that follows at once
	// gets a fresh layer and the fading one cannot be mistaken for it — and a fade to transparent
	// removes it when done. Without motion it is removed on the spot. The entries go with the
	// element (their animations finish under the fade and their removals find nothing to do).
	return js.const_(
		EFFECTS.clear,
		js.arrow(
			[],
			[
				js.assign(js.member(live, "length"), n(0)),
				js.assign(js.member(chips, "length"), n(0)),
				js.assign(id("efMark"), js.nil()),
				js.assign(id("efChipMark"), js.nil()),
				js.assign(id("efElement"), js.nil()),
				...fadeOutLayer("efFind", p.cls),
			]
		)
	);
}
