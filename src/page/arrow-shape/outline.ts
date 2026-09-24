// src/page/arrow-shape/outline.ts
/**
 * The silhouette's path text and paint: `<prefix>ArrowPath(length)`, in the dotted mode
 * `<prefix>ArrowHeadPath(length)`, the fading `<prefix>ArrowGradient(name, color, length)`, and
 * the soft drop shadow the draw routine attaches to every arrow group.
 */

import { type Expression, js, type Statement } from "@pagescript";
import { add, callm as call, id, mul, n, s, text as string, sub } from "../parts/ast";
import { setAttr as attr, svgEl as svg } from "../parts/svg";
import { ARROW_SHADOW_OPACITY, type ArrowGeometry } from "./geometry";

export interface OutlineNames {
	path: string;
	headPath: string;
	gradient: string;
}

export interface OutlineRoutines {
	path: Statement;
	headPath: Statement;
	gradient: Statement;
}

export function outlineRoutines(S: ArrowGeometry, names: OutlineNames): OutlineRoutines {
	const pathName = names.path;
	const headPathName = names.headPath;
	const gradientName = names.gradient;
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
	return { path, headPath, gradient };
}

/**
 * Inside the draw routine, with `name`, `length`, `dx`, `dy`, `distance`, `color`,
 * `defs` and `group` in scope: the arrow's drop-shadow filter, added to `defs` and applied to
 * the group.
 */
export function shadowStatements(S: ArrowGeometry, colors: Expression): Statement[] {
	return [
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
		attr(id("shadow"), "flood-color", js.or(js.member(colors, "edge"), id("color"))),
		attr(id("shadow"), "flood-opacity", s(String(ARROW_SHADOW_OPACITY))),
		js.expr(call(id("shadowFilter"), "appendChild", id("shadow"))),
		js.expr(call(id("defs"), "appendChild", id("shadowFilter"))),
		attr(id("group"), "filter", js.tpl(["url(#", ")"], id("shadowName"))),
	];
}
