// src/page/effects-overlay/marks.ts
/**
 * The effect kinds' marks: a directional effect is the recommendation arrow itself, downscaled
 * (`arrow-shape.ts`), and a capture is the seize outline on the captured square. `efEffect`
 * draws one wire effect into its own group, registers it in `efLive` and runs the group's hold
 * and fade.
 */

import {
	BOARD_EFFECT_GEOMETRY as G,
	BOARD_EFFECT_LIMITS as L,
	BOARD_EFFECT_MOTION as M,
	BOARD_EFFECT_SEIZE as Z,
} from "@core/constants/board-effects";
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { js, type Statement } from "@pagescript";
import { arrowStubLength } from "../arrow-shape";
import { add, callm, id, n, s, sub, text } from "../parts/ast";
import { setAttr as attr, svgEl as svg } from "../parts/svg";
import { forgetOnFinish, LIVE as live } from "./bookkeeping";
import type { EffectsParams } from "./names";

/** One effect group's life, and where its hold ends inside it. */
const LIFE = M.drawMs + M.holdMs + M.fadeMs;
const HOLD_END = (M.drawMs + M.holdMs) / LIFE;
/** The stub the arrow draw grows from, at the layer's arrow scale. */
const ARROW_STUB = arrowStubLength(G.arrowScale);
/** The seize outline scales about the captured square's centre, the origin of its own group. */
const SEIZE_ORIGIN = "transform-origin:0px 0px";

export function arrowColors(p: Pick<EffectsParams, "palette">): Statement {
	/**
	 * The arrow's bound colours: the fill it falls back to (every effect passes its own) and the
	 * shadow tint, both from the palette.
	 */
	return js.const_(
		"efArrowColors",
		js.obj({ arrow: js.member(p.palette, "mine"), edge: js.member(p.palette, "edge") })
	);
}

/** `efArrowEffect`, `efSeize` and `efEffect`, in that order. */
export function markRoutines(p: Pick<EffectsParams, "palette" | "styles">): Statement[] {
	const el = id("el");
	const black = id("black");
	const st = id("st");
	const group = id("group");
	const entry = id("entry");

	/**
	 * A directional effect is the recommendation arrow itself: `efArrow` (the silhouette from
	 * `arrow-shape.ts`, emitted above at `BOARD_EFFECT_GEOMETRY.arrowScale`) draws it statically
	 * into the group, sized by the kind's `scale` and dotted by its `dash`, and the draw is this
	 * layer's own — the shape (the whole silhouette, or the head when dotted) grows from the stub to
	 * its full path over `drawMs` after the fan's `delay`, invisible until then, and a dotted shaft
	 * runs its dots from the tail to the head over the same draw — while the hold and fade run on
	 * the group in `efEffect`, as for every kind.
	 */
	const efArrowEffect = js.const_(
		"efArrowEffect",
		js.arrow(
			["g", "e", "color", "st", "black", "motion", "delay", "anims"],
			[
				js.const_(
					"inner",
					js.call(
						id("efArrow"),
						id("g"),
						js.obj({
							[W.from]: js.member(id("e"), W.from),
							[W.to]: js.member(id("e"), W.to),
							[W.color]: id("color"),
						}),
						black,
						js.bool(false),
						js.member(st, "scale"),
						js.member(st, "dash")
					)
				),
				js.if_(js.not(js.and(id("inner"), id("motion"))), [js.ret()]),
				js.const_("shape", callm(id("inner"), "querySelector", s("path"))),
				js.const_("shaft", callm(id("inner"), "querySelector", s("line"))),
				js.const_(
					"timing",
					js.obj({
						duration: n(M.drawMs),
						delay: id("delay"),
						easing: s(M.easing),
						fill: s("backwards"),
					})
				),
				js.expr(
					js.call(
						id("efAnimate"),
						id("shape"),
						js.arr(
							js.obj({
								d: js.tpl(
									['path("', '")'],
									js.cond(
										id("shaft"),
										js.call(id("efArrowHeadPath"), n(ARROW_STUB)),
										js.call(id("efArrowPath"), n(ARROW_STUB))
									)
								),
								opacity: n(0),
							}),
							js.obj({
								d: js.tpl(['path("', '")'], callm(id("shape"), "getAttribute", s("d"))),
								opacity: n(1),
							})
						),
						id("timing"),
						id("anims")
					)
				),
				js.if_(id("shaft"), [
					js.const_(
						"run",
						sub(
							js.call(id("Number"), callm(id("shaft"), "getAttribute", s("x2"))),
							js.call(id("Number"), callm(id("shaft"), "getAttribute", s("x1")))
						)
					),
					js.expr(
						js.call(
							id("efAnimate"),
							id("shaft"),
							js.arr(
								js.obj({ strokeDashoffset: text(id("run")), opacity: n(0) }),
								js.obj({ strokeDashoffset: s("0"), opacity: n(1) })
							),
							id("timing"),
							id("anims")
						)
					),
				]),
			]
		)
	);

	/**
	 * The capture — the seize mark (2026-09-13, replacing the slash): a rounded-square outline in
	 * the mover's colour, centred on the captured square, that starts a little larger than the
	 * square and contracts onto it, fading to transparent as it lands. The outline sits in its own
	 * group translated to the square's centre, so the scale is about that centre. Without motion it
	 * is drawn once at the square's own size.
	 */
	const efSeize = js.const_(
		"efSeize",
		js.arrow(
			["g", "x", "y", "color", "motion", "delay", "anims"],
			[
				js.const_("mark", svg("g")),
				attr(id("mark"), "transform", js.tpl(["translate(", " ", ")"], id("x"), id("y"))),
				js.const_("box", svg("rect")),
				attr(id("box"), "x", s("-0.5")),
				attr(id("box"), "y", s("-0.5")),
				attr(id("box"), "width", s("1")),
				attr(id("box"), "height", s("1")),
				attr(id("box"), "rx", s(String(Z.radius))),
				attr(id("box"), "ry", s(String(Z.radius))),
				attr(id("box"), "fill", s("none")),
				attr(id("box"), "stroke", id("color")),
				attr(id("box"), "stroke-width", s(String(Z.width))),
				attr(id("box"), "style", s(SEIZE_ORIGIN)),
				js.expr(callm(id("mark"), "appendChild", id("box"))),
				js.expr(callm(id("g"), "appendChild", id("mark"))),
				js.if_(id("motion"), [
					js.expr(
						js.call(
							id("efAnimate"),
							id("box"),
							js.arr(
								js.obj({ transform: s(`scale(${Z.from})`), opacity: n(1) }),
								js.obj({ transform: s(`scale(${Z.to})`), opacity: n(0) })
							),
							js.obj({
								duration: n(Z.ms),
								delay: id("delay"),
								easing: s(M.easing),
								fill: s("both"),
							}),
							id("anims")
						)
					),
				]),
			]
		)
	);

	const efEffect = js.const_(
		"efEffect",
		js.arrow(
			["el", "e", "black", "mine", "motion", "delay"],
			[
				js.const_("st", js.member(p.styles, js.member(id("e"), W.effectKind))),
				js.if_(js.not(st), [js.ret()]),
				// One colour per side, whatever the kind (owner, 2026-09-13: the enemy's castle and
				// uncovering lines red like the capture, ours blue).
				js.const_(
					"color",
					js.cond(id("mine"), js.member(p.palette, "mine"), js.member(p.palette, "theirs"))
				),
				// The target square's centre, for the on-square marks.
				js.const_("b", js.call(id("efCell"), js.member(id("e"), W.to), black)),
				js.const_("x2", add(js.member(id("b"), n(0)), n(0.5))),
				js.const_("y2", add(js.member(id("b"), n(1)), n(0.5))),
				js.const_("group", svg("g")),
				js.expr(callm(el, "appendChild", group)),
				js.const_("entry", js.obj({ node: group, anims: js.arr() })),
				js.expr(callm(live, "push", entry)),
				js.expr(js.call(id("efTrim"), live, n(L.maxLiveGroups))),
				js.const_("anims", js.member(entry, "anims")),
				js.if_(js.op(js.member(st, "scale"), ">", n(0)), [
					js.expr(
						js.call(
							id("efArrowEffect"),
							group,
							id("e"),
							id("color"),
							st,
							black,
							id("motion"),
							id("delay"),
							id("anims")
						)
					),
				]),
				js.if_(js.member(st, "seize"), [
					js.expr(
						js.call(
							id("efSeize"),
							group,
							id("x2"),
							id("y2"),
							id("color"),
							id("motion"),
							id("delay"),
							id("anims")
						)
					),
				]),
				js.if_(id("motion"), [
					js.const_(
						"fade",
						js.call(
							id("efAnimate"),
							group,
							js.arr(
								js.obj({ opacity: n(1), offset: n(0) }),
								js.obj({ opacity: n(1), offset: n(HOLD_END) }),
								js.obj({ opacity: n(0), offset: n(1) })
							),
							js.obj({ duration: n(LIFE), delay: id("delay"), fill: s("forwards") }),
							id("anims")
						)
					),
					forgetOnFinish(id("fade"), live, group),
				]),
			]
		)
	);

	return [efArrowEffect, efSeize, efEffect];
}
