// src/page/cursor-effects/trail.ts
/**
 * The ghost trail: the last dispatched points (`curFxPoints`), trimmed to
 * `CURSOR_EFFECTS.trailLengthPx` of path, drawn as translucent accent copies of the arrow
 * artwork parked a few points behind the head, fading out between points.
 */

import { CURSOR_EFFECTS as E } from "@core/constants/cursor";
import { type Expression, js, type Statement } from "@pagescript";
import { add, at, callm as call, div, id, mul, n, run, s, sub } from "../parts/ast";
import { setAttr as attr } from "../parts/svg";
import type { CursorEffectParams } from "./params";

const doc = id("document");

/** Screen distance between two `[x, y]` points. */
export const distance = (a: Expression, b: Expression): Expression =>
	call(id("Math"), "hypot", sub(at(a, 0), at(b, 0)), sub(at(a, 1), at(b, 1)));

/** `curFxTrim()` and `curFxDrawTrail(cursor)`, in that order. */
export function trailRoutines(p: CursorEffectParams): Statement[] {
	const trim = js.const_(
		"curFxTrim",
		js.arrow(
			[],
			[
				js.while_(js.op(js.member(id("curFxPoints"), "length"), ">", n(E.maxPoints)), [
					js.expr(call(id("curFxPoints"), "shift")),
				]),
				js.let_("length", n(0)),
				js.let_("index", n(1)),
				js.while_(js.op(id("index"), "<", js.member(id("curFxPoints"), "length")), [
					js.assign(
						id("length"),
						add(
							id("length"),
							distance(at(id("curFxPoints"), id("index")), at(id("curFxPoints"), sub(id("index"), n(1))))
						)
					),
					js.assign(id("index"), add(id("index"), n(1))),
				]),
				js.while_(
					js.and(
						js.op(id("length"), ">", n(E.trailLengthPx)),
						js.op(js.member(id("curFxPoints"), "length"), ">", n(2))
					),
					[
						js.assign(
							id("length"),
							sub(id("length"), distance(at(id("curFxPoints"), 0), at(id("curFxPoints"), 1)))
						),
						js.expr(call(id("curFxPoints"), "shift")),
					]
				),
				js.if_(js.op(id("length"), ">", n(E.trailLengthPx)), [
					js.const_("tail", at(id("curFxPoints"), 0)),
					js.const_("head", at(id("curFxPoints"), 1)),
					js.const_("fraction", div(n(E.trailLengthPx), id("length"))),
					js.assign(
						at(id("curFxPoints"), 0),
						js.arr(
							add(at(id("head"), 0), mul(sub(at(id("tail"), 0), at(id("head"), 0)), id("fraction"))),
							add(at(id("head"), 1), mul(sub(at(id("tail"), 1), at(id("head"), 1)), id("fraction")))
						)
					),
				]),
			]
		)
	);
	const lags = js.arr(...E.ghosts.map((ghost) => n(ghost.lag)));
	const opacities = js.arr(...E.ghosts.map((ghost) => n(ghost.opacity)));
	// Translucent copies of the artwork itself, each parked a few dispatched points behind the head.
	const trail = js.const_(
		"curFxDrawTrail",
		js.arrow(
			["cursor"],
			[
				js.let_("layer", run("curFxFind")),
				js.if_(js.not(id("layer")), [
					js.const_("art", call(id("cursor"), "querySelector", s("svg"))),
					js.if_(js.not(id("art")), [js.ret()]),
					js.assign(id("layer"), call(doc, "createElement", s("div"))),
					attr(id("layer"), "class", js.tpl(["", "e"], p.cls)),
					attr(
						id("layer"),
						"style",
						s(`position:fixed;inset:0;overflow:visible;pointer-events:none;z-index:${p.zIndex};`)
					),
					js.forOf("ghost", opacities, [
						js.const_("copy", call(id("art"), "cloneNode", js.bool(true))),
						js.while_(js.op(js.member(id("copy"), "childElementCount"), ">", n(2)), [
							js.expr(call(js.member(id("copy"), "lastElementChild"), "remove")),
						]),
						// Tinted through and through: the body takes the accent, the inner shape a darker cut
						// of it, so the copies read as an orange echo rather than a second white pointer.
						attr(js.member(id("copy"), "firstElementChild"), "fill", p.accent),
						attr(js.member(id("copy"), "lastElementChild"), "fill", p.accent),
						attr(
							js.member(id("copy"), "lastElementChild"),
							"fill-opacity",
							s(String(E.ghostInnerOpacity))
						),
						attr(
							id("copy"),
							"style",
							js.tpl(
								[
									`position:fixed;left:0;top:0;width:${p.sizePx}px;height:${p.sizePx}px;pointer-events:none;will-change:transform;opacity:`,
									`;filter:drop-shadow(0 0 ${E.ghostShadowBlurPx}px `,
									");",
								],
								id("ghost"),
								p.accent
							)
						),
						js.expr(call(id("layer"), "appendChild", id("copy"))),
					]),
					// Beside the arrow, under `<html>` (see `curEnsure`): no site stacking context above it.
					js.expr(call(js.member(doc, "documentElement"), "appendChild", id("layer"))),
				]),
				js.let_("index", n(0)),
				js.forOf("copy", js.member(id("layer"), "children"), [
					js.const_(
						"slot",
						sub(sub(js.member(id("curFxPoints"), "length"), n(1)), at(lags, id("index")))
					),
					js.if_(
						js.op(id("slot"), "<", n(0)),
						[js.assign(js.member(id("copy"), "style", "opacity"), s("0"))],
						[
							js.const_("point", at(id("curFxPoints"), id("slot"))),
							js.assign(
								js.member(id("copy"), "style", "opacity"),
								js.call(id("String"), at(opacities, id("index")))
							),
							js.assign(
								js.member(id("copy"), "style", "transform"),
								js.tpl(
									["translate3d(", "px,", "px,0)"],
									sub(at(id("point"), 0), n(p.hotX)),
									sub(at(id("point"), 1), n(p.hotY))
								)
							),
						]
					),
					js.assign(id("index"), add(id("index"), n(1))),
				]),
				js.expr(run("curFxStop", id("layer"))),
				js.const_(
					"animation",
					call(
						id("layer"),
						"animate",
						js.arr(js.obj({ opacity: n(1) }), js.obj({ opacity: n(0) })),
						js.obj({ duration: n(E.trailFadeMs), easing: s("ease-out") })
					)
				),
				js.assign(id("curFxTrailAnimation"), id("animation")),
				js.expr(
					call(
						js.member(id("animation"), "finished"),
						"then",
						js.arrow(
							[],
							[
								js.if_(js.op(id("curFxTrailAnimation"), "===", id("animation")), [
									js.expr(call(id("layer"), "remove")),
									js.assign(id("curFxTrailAnimation"), js.nil()),
									js.assign(id("curFxPoints"), js.arr(call(id("curFxPoints"), "at", n(-1)))),
								]),
							]
						),
						js.arrow([], [])
					)
				),
			]
		)
	);
	return [trim, trail];
}
