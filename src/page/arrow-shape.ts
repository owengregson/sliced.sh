/** A single rounded arrow silhouette: no translucent shaft/head seam. */
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { HIGHLIGHT_MOTION as M } from "@core/constants/timings";
import { type Expression, js, type Statement } from "@pagescript";

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

export function arrowShapeStatements(p: { cls: Expression; colors: Expression }): Statement[] {
	const half = A.shaftHalfWidth;
	const head = A.headHalfWidth;
	const r = A.cornerRadius;
	const h = sub(id("length"), n(A.headLength));
	const path = js.const_(
		"ovArrowPath",
		js.arrow(
			["length"],
			[
				js.ret(
					js.tpl(
						[
							`M ${A.tailRadius},${-half} H `,
							` Q `,
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
							`,${half} H ${A.tailRadius} Q 0,${half} 0,0 Q 0,${-half} ${A.tailRadius},${-half} Z`,
						],
						sub(h, n(r)),
						h,
						h,
						h,
						add(h, n(r)),
						sub(id("length"), n(A.tipRadius)),
						add(id("length"), n(A.tipRadius)),
						sub(id("length"), n(A.tipRadius)),
						add(h, n(r)),
						h,
						h,
						h,
						sub(h, n(r))
					)
				),
			]
		)
	);
	const gradient = js.const_(
		"ovArrowGradient",
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
	const draw = js.const_(
		"ovArrow",
		js.arrow(
			["el", "a", "black", "motion"],
			[
				js.const_("start", js.call(id("ovCell"), js.member(id("a"), W.from), id("black"))),
				js.const_("end", js.call(id("ovCell"), js.member(id("a"), W.to), id("black"))),
				js.const_("dx", sub(js.member(id("end"), n(0)), js.member(id("start"), n(0)))),
				js.const_("dy", sub(js.member(id("end"), n(1)), js.member(id("start"), n(1)))),
				js.const_("distance", call(id("Math"), "hypot", id("dx"), id("dy"))),
				js.if_(js.op(id("distance"), "<=", n(A.startInset + A.headLength)), [js.ret()]),
				js.const_("length", sub(id("distance"), n(A.startInset))),
				js.const_(
					"x",
					add(
						add(js.member(id("start"), n(0)), n(0.5)),
						mul(js.op(id("dx"), "/", id("distance")), n(A.startInset))
					)
				),
				js.const_(
					"y",
					add(
						add(js.member(id("start"), n(1)), n(0.5)),
						mul(js.op(id("dy"), "/", id("distance")), n(A.startInset))
					)
				),
				js.const_("angle", mul(call(id("Math"), "atan2", id("dy"), id("dx")), n(180 / Math.PI))),
				js.assign(id("ovArrowSerial"), add(id("ovArrowSerial"), n(1))),
				js.const_("name", js.tpl(["", "a", ""], p.cls, id("ovArrowSerial"))),
				js.const_("color", js.or(js.member(id("a"), W.color), js.member(p.colors, "arrow"))),
				js.const_("group", svg("g")),
				attr(
					id("group"),
					"transform",
					js.tpl(["translate(", " ", ") rotate(", ")"], id("x"), id("y"), id("angle"))
				),
				js.const_("defs", svg("defs")),
				js.const_("fadeLength", call(id("Math"), "min", n(A.fadeLength), mul(id("length"), n(0.3)))),
				js.expr(
					call(
						id("defs"),
						"appendChild",
						js.call(id("ovArrowGradient"), id("name"), id("color"), id("fadeLength"))
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
				attr(id("shadow"), "dx", string(mul(js.op(id("dy"), "/", id("distance")), n(A.shadowOffset)))),
				attr(id("shadow"), "dy", string(mul(js.op(id("dx"), "/", id("distance")), n(A.shadowOffset)))),
				attr(id("shadow"), "stdDeviation", s(String(A.shadowBlur))),
				attr(id("shadow"), "flood-color", js.or(js.member(p.colors, "edge"), id("color"))),
				attr(id("shadow"), "flood-opacity", s(String(A.shadowOpacity))),
				js.expr(call(id("shadowFilter"), "appendChild", id("shadow"))),
				js.expr(call(id("defs"), "appendChild", id("shadowFilter"))),
				attr(id("group"), "filter", js.tpl(["url(#", ")"], id("shadowName"))),
				js.expr(call(id("group"), "appendChild", id("defs"))),
				js.const_("shape", svg("path")),
				js.const_("full", js.call(id("ovArrowPath"), id("length"))),
				attr(id("shape"), "d", id("full")),
				attr(id("shape"), "fill", js.tpl(["url(#", ")"], id("name"))),
				js.expr(call(id("group"), "appendChild", id("shape"))),
				js.expr(call(id("el"), "appendChild", id("group"))),
				js.if_(id("motion"), [
					js.expr(
						js.call(
							id("ovAnimate"),
							id("shape"),
							js.arr(
								js.obj({
									d: js.tpl(
										['path("', '")'],
										js.call(id("ovArrowPath"), n(A.headLength + A.tailRadius + r))
									),
									filter: s("brightness(1.08)"),
								}),
								js.obj({ d: js.tpl(['path("', '")'], id("full")), filter: s("brightness(1)") })
							),
							js.obj({ duration: n(M.arrowDrawMs), easing: s(M.drawEasing) })
						)
					),
					js.const_(
						"fade",
						js.call(
							id("ovAnimate"),
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
			]
		)
	);
	return [js.let_("ovArrowSerial", n(0)), path, gradient, draw];
}
