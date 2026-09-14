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

/** The silhouette at scale 1, in board units (1 = one square). `shadowOpacity` is not a length. */
const A = {
	shaftHalfWidth: 0.105,
	headHalfWidth: 0.3,
	headLength: 0.43,
	cornerRadius: 0.04,
	startInset: 0.25,
	tailRadius: 0.1,
	tipRadius: 0.055,
	shadowOffset: 0.026,
	shadowBlur: 0.018,
	shadowOpacity: 0.18,
	fadeLength: 0.9,
} as const;

export type ArrowGeometry = Record<Exclude<keyof typeof A, "shadowOpacity">, number>;

/**
 * Every length of the silhouette multiplied by `scale`, rounded to six decimals so the emitted
 * numbers stay short. At scale 1 every value is exactly `A`'s.
 */
export function arrowGeometry(scale = 1): ArrowGeometry {
	const at = (v: number): number => Number((v * scale).toFixed(6));
	return {
		shaftHalfWidth: at(A.shaftHalfWidth),
		headHalfWidth: at(A.headHalfWidth),
		headLength: at(A.headLength),
		cornerRadius: at(A.cornerRadius),
		startInset: at(A.startInset),
		tailRadius: at(A.tailRadius),
		tipRadius: at(A.tipRadius),
		shadowOffset: at(A.shadowOffset),
		shadowBlur: at(A.shadowBlur),
		fadeLength: at(A.fadeLength),
	};
}

/** The stub the draw animation grows from: the head, the tail cap and one corner, at `scale`. */
export function arrowStubLength(scale = 1): number {
	const g = arrowGeometry(scale);
	return g.headLength + g.tailRadius + g.cornerRadius;
}

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

const id = js.id;
const n = js.num;
const s = js.str;
const add = (a: Expression, b: Expression) => js.op(a, "+", b);
const sub = (a: Expression, b: Expression) => js.op(a, "-", b);
const mul = (a: Expression, b: Expression) => js.op(a, "*", b);
const call = (el: Expression, method: string, ...args: Expression[]) =>
	js.call(js.member(el, method), ...args);
const svg = (tag: string) =>
	call(id("document"), "createElementNS", s("http://www.w3.org/2000/svg"), s(tag));
const attr = (el: Expression, name: string, value: Expression): Statement =>
	js.expr(call(el, "setAttribute", s(name), value));
const string = (value: Expression) => js.call(id("String"), value);

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
	const head = S.headHalfWidth;
	const r = S.cornerRadius;
	const h = sub(id("length"), n(S.headLength));
	// The head — from the shaft's last corner at `h − r` round the tip and back — is one run of
	// path text shared by the full silhouette and the head-only path, so the two agree exactly.
	const headText = [
		`,${-half} `,
		`,${-half - r} V ${-head + r} Q `,
		`,${-head} `,
		`,${-head + r} L `,
		`,${-r} Q `,
		`,0 `,
		`,${r} L `,
		`,${head - r} Q `,
		`,${head} `,
		`,${head - r} V ${half + r} Q `,
		`,${half} `,
	];
	const headPoints = (): Expression[] => [
		sub(h, n(r)),
		h,
		h,
		h,
		add(h, n(r)),
		sub(id("length"), n(S.tipRadius)),
		add(id("length"), n(S.tipRadius)),
		sub(id("length"), n(S.tipRadius)),
		add(h, n(r)),
		h,
		h,
		h,
		sub(h, n(r)),
	];
	const path = js.const_(
		pathName,
		js.arrow(
			["length"],
			[
				js.ret(
					js.tpl(
						[
							`M ${S.tailRadius},${-half} H `,
							` Q `,
							...headText,
							`,${half} H ${S.tailRadius} Q 0,${half} 0,0 Q 0,${-half} ${S.tailRadius},${-half} Z`,
						],
						...headPoints()
					)
				),
			]
		)
	);
	// The head alone, closed straight across its base at `h − r`: the dotted shaft's round cap ends
	// under it.
	const headPath = js.const_(
		headPathName,
		js.arrow(
			["length"],
			[js.ret(js.tpl([`M `, `,${-half} Q `, ...headText, `,${half} Z`], ...headPoints()))]
		)
	);
	const gradient = js.const_(
		gradientName,
		js.arrow(
			["name", "color", "length"],
			[
				js.const_("gradient", svg("linearGradient")),
				attr(id("gradient"), "id", id("name")),
				attr(id("gradient"), "gradientUnits", s("userSpaceOnUse")),
				attr(id("gradient"), "x1", s("0")),
				attr(id("gradient"), "y1", s("0")),
				attr(id("gradient"), "x2", string(id("length"))),
				attr(id("gradient"), "y2", s("0")),
				js.forOf("entry", js.arr(js.arr(n(0), n(0)), js.arr(n(0.35), n(0.45)), js.arr(n(1), n(1))), [
					js.const_("stop", svg("stop")),
					attr(id("stop"), "offset", string(js.member(id("entry"), n(0)))),
					attr(id("stop"), "stop-color", id("color")),
					attr(id("stop"), "stop-opacity", string(js.member(id("entry"), n(1)))),
					js.expr(call(id("gradient"), "appendChild", id("stop"))),
				]),
				js.ret(id("gradient")),
			]
		)
	);
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
				// A soft screen-down shadow adds depth without tracing the perimeter.
				// Rotate its local offset against the arrow so lighting stays consistent.
				js.const_("shadowName", add(id("name"), s("s"))),
				js.const_("shadowFilter", svg("filter")),
				attr(id("shadowFilter"), "id", id("shadowName")),
				attr(id("shadowFilter"), "filterUnits", s("userSpaceOnUse")),
				attr(id("shadowFilter"), "x", s("-0.15")),
				attr(id("shadowFilter"), "y", s("-0.45")),
				attr(id("shadowFilter"), "width", string(add(id("length"), n(0.3)))),
				attr(id("shadowFilter"), "height", s("0.9")),
				attr(id("shadowFilter"), "color-interpolation-filters", s("sRGB")),
				js.const_("shadow", svg("feDropShadow")),
				attr(id("shadow"), "dx", string(mul(js.op(id("dy"), "/", id("distance")), n(S.shadowOffset)))),
				attr(id("shadow"), "dy", string(mul(js.op(id("dx"), "/", id("distance")), n(S.shadowOffset)))),
				attr(id("shadow"), "stdDeviation", s(String(S.shadowBlur))),
				attr(id("shadow"), "flood-color", js.or(js.member(p.colors, "edge"), id("color"))),
				attr(id("shadow"), "flood-opacity", s(String(A.shadowOpacity))),
				js.expr(call(id("shadowFilter"), "appendChild", id("shadow"))),
				js.expr(call(id("defs"), "appendChild", id("shadowFilter"))),
				attr(id("group"), "filter", js.tpl(["url(#", ")"], id("shadowName"))),
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
