/**
 * A single rounded arrow silhouette: no translucent shaft/head seam.
 *
 * The recommendation mark owns it (`highlight-overlay.ts`, the `ov` prefix), and the board-effect
 * layer emits the same silhouette a second time under its own prefix and a build-time scale
 * (`effects-overlay.ts`; owner, 2026-09-13: "reuse the arrows from highlight move, but downscale
 * them"). With the defaults the emitted routines are the recommendation mark's, unchanged.
 *
 * The dotted mode (`dotGapRatio`, the effect layer's line kinds — owner, 2026-09-13: "include
 * making them dotted like they were before (a modified version of the highlight move arrow)")
 * draws the same silhouette as a filled head plus a round-dotted shaft line, under the same
 * gradient and shadow, when the draw routine's `dash` argument is above zero.
 */
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { HIGHLIGHT_MOTION as M } from "@core/constants/timings";
import { type Expression, js, type Statement } from "@pagescript";
import { arrowGeometry, arrowStubLength } from "./arrow-shape/geometry";
import { outlineRoutines, shadowStatements } from "./arrow-shape/outline";
import { add, callm as call, id, mul, n, s, text as string, sub } from "./parts/ast";
import { setAttr as attr, svgEl as svg } from "./parts/svg";

export { type ArrowGeometry, arrowGeometry, arrowStubLength } from "./arrow-shape/geometry";

export interface ArrowShapeOptions {
	/** The overlay's per-build class: scopes the gradient and filter ids. */
	cls: Expression;
	/** `{ arrow, edge }`: the fallback fill when the arrow carries no colour, and the shadow tint. */
	colors: Expression;
	/**
	 * Identifier prefix of the emitted routines — `${prefix}ArrowPath`, `${prefix}ArrowGradient`,
	 * `${prefix}Arrow`, `${prefix}ArrowSerial`, and in the dotted mode `${prefix}ArrowHeadPath`.
	 * Default `ov`, the recommendation mark's.
	 */
	prefix?: string;
	/** Name of the `(square, black) => [col, row]` routine in scope. Default `ovCell`. */
	cell?: string;
	/** Name of the `(node, frames, options) => Animation` routine in scope. Default `ovAnimate`. */
	animate?: string;
	/** Multiplier on every length of the silhouette, baked at build time. Default 1. */
	scale?: number;
	/**
	 * Give `${prefix}Arrow` a fifth argument, a runtime multiplier on the silhouette: the shape is
	 * built at `length / k` and drawn under `scale(k)`, so the tip still lands on the target while
	 * the body grows or shrinks around its start. Default off (the recommendation mark's signature).
	 */
	sizeArg?: boolean;
	/**
	 * Give `${prefix}Arrow` a `dash` argument (after `size`): the dot length in board units at
	 * scale 1, `0` for the filled silhouette exactly as without this option. Above `0` the SAME
	 * geometry is drawn as two parts under the same gradient and shadow — the head as a filled path
	 * (`${prefix}ArrowHeadPath`, emitted only then) and the shaft as a round-capped dotted `line`,
	 * dots of `dash` and gaps of `dash × dotGapRatio`, both multiplied by `scale` like every other
	 * length. The value is that gap-to-dot ratio. Default off (the recommendation mark's signature).
	 */
	dotGapRatio?: number;
}

export function arrowShapeStatements(p: ArrowShapeOptions): Statement[] {
	const prefix = p.prefix ?? "ov";
	const cell = id(p.cell ?? "ovCell");
	const animate = id(p.animate ?? "ovAnimate");
	const scale = p.scale ?? 1;
	const S = arrowGeometry(scale);
	const pathName = `${prefix}ArrowPath`;
	const headPathName = `${prefix}ArrowHeadPath`;
	const gradientName = `${prefix}ArrowGradient`;
	const drawName = `${prefix}Arrow`;
	const serialName = `${prefix}ArrowSerial`;
	const dotted = p.dotGapRatio !== undefined;
	const half = S.shaftHalfWidth;
	const { path, headPath, gradient } = outlineRoutines(S, {
		path: pathName,
		headPath: headPathName,
		gradient: gradientName,
	});
	// The runtime size multiplier (`sizeArg`): the path is built at `length / k` and the shape drawn
	// under `scale(k)`, so the tip stays put and the body scales about the start.
	const k = id("k");
	const shapeLength: Expression = p.sizeArg ? js.op(id("length"), "/", k) : id("length");
	// The dotted mode (`dotGapRatio`): `dot` is the dash argument, `shaft` the `<line>` it draws
	// (null when solid), and `reach` the shaft's far end — the head's base less its corner.
	const shaft = id("shaft");
	const dotOn = js.op(id("dot"), ">", n(0));
	const stubLength = n(arrowStubLength(scale));
	const stubPath: Expression = dotted
		? js.cond(dotOn, js.call(id(headPathName), stubLength), js.call(id(pathName), stubLength))
		: js.call(id(pathName), stubLength);
	const fullPath: Expression = dotted
		? js.cond(dotOn, js.call(id(headPathName), shapeLength), js.call(id(pathName), shapeLength))
		: js.call(id(pathName), shapeLength);
	const dotUnits = (ratio: number): Expression =>
		mul(id("dot"), n(Number((scale * ratio).toFixed(6))));
	const draw = js.const_(
		drawName,
		js.arrow(
			["el", "a", "black", "motion", ...(p.sizeArg ? ["size"] : []), ...(dotted ? ["dash"] : [])],
			[
				js.const_("start", js.call(cell, js.member(id("a"), W.from), id("black"))),
				js.const_("end", js.call(cell, js.member(id("a"), W.to), id("black"))),
				js.const_("dx", sub(js.member(id("end"), n(0)), js.member(id("start"), n(0)))),
				js.const_("dy", sub(js.member(id("end"), n(1)), js.member(id("start"), n(1)))),
				js.const_("distance", call(id("Math"), "hypot", id("dx"), id("dy"))),
				js.if_(js.op(id("distance"), "<=", n(S.startInset + S.headLength)), [js.ret()]),
				js.const_("length", sub(id("distance"), n(S.startInset))),
				...(p.sizeArg ? [js.const_("k", js.or(id("size"), n(1)))] : []),
				...(dotted
					? [
							js.const_("dot", js.or(id("dash"), n(0))),
							js.const_("shaft", js.cond(dotOn, svg("line"), js.nil())),
							js.const_("reach", sub(shapeLength, n(Number((S.headLength + S.cornerRadius).toFixed(6))))),
						]
					: []),
				js.const_(
					"x",
					add(
						add(js.member(id("start"), n(0)), n(0.5)),
						mul(js.op(id("dx"), "/", id("distance")), n(S.startInset))
					)
				),
				js.const_(
					"y",
					add(
						add(js.member(id("start"), n(1)), n(0.5)),
						mul(js.op(id("dy"), "/", id("distance")), n(S.startInset))
					)
				),
				js.const_("angle", mul(call(id("Math"), "atan2", id("dy"), id("dx")), n(180 / Math.PI))),
				js.assign(id(serialName), add(id(serialName), n(1))),
				js.const_("name", js.tpl(["", "a", ""], p.cls, id(serialName))),
				js.const_("color", js.or(js.member(id("a"), W.color), js.member(p.colors, "arrow"))),
				js.const_("group", svg("g")),
				attr(
					id("group"),
					"transform",
					js.tpl(["translate(", " ", ") rotate(", ")"], id("x"), id("y"), id("angle"))
				),
				js.const_("defs", svg("defs")),
				js.const_("fadeLength", call(id("Math"), "min", n(S.fadeLength), mul(id("length"), n(0.3)))),
				js.expr(
					call(
						id("defs"),
						"appendChild",
						js.call(id(gradientName), id("name"), id("color"), id("fadeLength"))
					)
				),
				...shadowStatements(S, p.colors),
				js.expr(call(id("group"), "appendChild", id("defs"))),
				js.const_("shape", svg("path")),
				js.const_("full", fullPath),
				attr(id("shape"), "d", id("full")),
				attr(id("shape"), "fill", js.tpl(["url(#", ")"], id("name"))),
				...(p.sizeArg ? [attr(id("shape"), "transform", js.tpl(["scale(", ")"], k))] : []),
				// The dotted shaft goes under the head: a line down the arrow's axis from the tail cap to
				// the head's base, the silhouette's shaft width, painted through the same gradient, its
				// dots and gaps in path units so they scale with the arrow.
				...(dotted
					? [
							js.if_(shaft, [
								attr(shaft, "x1", s(String(S.tailRadius))),
								attr(shaft, "y1", s("0")),
								attr(shaft, "x2", string(id("reach"))),
								attr(shaft, "y2", s("0")),
								attr(shaft, "fill", s("none")),
								attr(shaft, "stroke", js.tpl(["url(#", ")"], id("name"))),
								attr(shaft, "stroke-width", s(String(Number((half * 2).toFixed(6))))),
								attr(shaft, "stroke-linecap", s("round")),
								attr(
									shaft,
									"stroke-dasharray",
									js.tpl(["", " ", ""], dotUnits(1), dotUnits(p.dotGapRatio ?? 1))
								),
								...(p.sizeArg ? [attr(shaft, "transform", js.tpl(["scale(", ")"], k))] : []),
								js.expr(call(id("group"), "appendChild", shaft)),
							]),
						]
					: []),
				js.expr(call(id("group"), "appendChild", id("shape"))),
				js.expr(call(id("el"), "appendChild", id("group"))),
				js.if_(id("motion"), [
					js.expr(
						js.call(
							animate,
							id("shape"),
							js.arr(
								js.obj({
									d: js.tpl(['path("', '")'], stubPath),
									filter: s("brightness(1.08)"),
								}),
								js.obj({ d: js.tpl(['path("', '")'], id("full")), filter: s("brightness(1)") })
							),
							js.obj({ duration: n(M.arrowDrawMs), easing: s(M.drawEasing) })
						)
					),
					// The dots run from the tail to the head over the same draw: the pattern is offset by
					// the shaft's length and slides back to zero.
					...(dotted
						? [
								js.if_(shaft, [
									js.expr(
										js.call(
											animate,
											shaft,
											js.arr(
												js.obj({
													strokeDashoffset: string(sub(id("reach"), n(S.tailRadius))),
												}),
												js.obj({ strokeDashoffset: s("0") })
											),
											js.obj({ duration: n(M.arrowDrawMs), easing: s(M.drawEasing) })
										)
									),
								]),
							]
						: []),
					js.const_(
						"fade",
						js.call(
							animate,
							id("group"),
							js.arr(
								js.obj({ opacity: n(1), offset: n(0) }),
								js.obj({
									opacity: n(1),
									offset: n(
										(M.arrowDrawMs + M.arrowHoldMs) / (M.arrowDrawMs + M.arrowHoldMs + M.arrowFadeMs)
									),
								}),
								js.obj({ opacity: n(0), offset: n(1) })
							),
							js.obj({ duration: n(M.arrowDrawMs + M.arrowHoldMs + M.arrowFadeMs), fill: s("forwards") })
						)
					),
					js.expr(
						call(
							js.member(id("fade"), "finished"),
							"then",
							js.arrow([], [js.expr(call(id("group"), "remove"))]),
							js.arrow([], [])
						)
					),
				]),
				// The drawn group, so a caller that passed `motion` false can run its own lifecycle.
				js.ret(id("group")),
			]
		)
	);
	return [js.let_(serialName, n(0)), path, ...(dotted ? [headPath] : []), gradient, draw];
}
