/** Cursor artwork feedback and one pooled tapered ribbon, driven by dispatched points only. */
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { CURSOR_EFFECTS as E } from "@core/constants/cursor";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { type Expression, js, type Statement } from "@pagescript";

const id = js.id;
const n = js.num;
const s = js.str;
const call = (target: Expression, method: string, ...args: Expression[]) =>
	js.call(js.member(target, method), ...args);
const run = (name: string, ...args: Expression[]) => js.call(id(name), ...args);
const at = (target: Expression, index: number | Expression) =>
	js.member(target, typeof index === "number" ? n(index) : index);
const add = (a: Expression, b: Expression) => js.op(a, "+", b);
const sub = (a: Expression, b: Expression) => js.op(a, "-", b);
const mul = (a: Expression, b: Expression) => js.op(a, "*", b);
const div = (a: Expression, b: Expression) => js.op(a, "/", b);
const doc = id("document");
const attr = (node: Expression, key: string, value: Expression) =>
	js.expr(call(node, "setAttribute", s(key), value));
const svg = (tag: string) => call(doc, "createElementNS", s("http://www.w3.org/2000/svg"), s(tag));
const pointText = (point: Expression) => js.tpl(["", " ", ""], at(point, 0), at(point, 1));
const distance = (a: Expression, b: Expression) =>
	call(id("Math"), "hypot", sub(at(a, 0), at(b, 0)), sub(at(a, 1), at(b, 1)));
const scale = (value: number) => s(`scale(${value})`);

export const CURSOR_FEEDBACK = { update: "curFxUpdate", clear: "curFxClear" } as const;

export function cursorEffectStatements(p: {
	cls: Expression;
	accent: Expression;
	zIndex: number;
	hotX: number;
	hotY: number;
}): Statement[] {
	const stop = js.const_(
		"curFxStop",
		js.arrow(
			["node"],
			[
				js.if_(
					js.and(
						id("node"),
						js.op(js.typeof_(js.member(id("node"), "getAnimations")), "===", s("function"))
					),
					[
						js.forOf("animation", call(id("node"), "getAnimations"), [
							js.expr(call(id("animation"), "cancel")),
						]),
					]
				),
			]
		)
	);
	const find = js.const_(
		"curFxFind",
		js.arrow([], call(doc, "querySelector", js.tpl([".", "e"], p.cls)))
	);
	const clearTrail = js.const_(
		"curFxClearTrail",
		js.arrow(
			[],
			[
				js.assign(id("curFxTrailAnimation"), js.nil()),
				js.const_("layer", run("curFxFind")),
				js.if_(id("layer"), [
					js.expr(run("curFxStop", id("layer"))),
					js.expr(call(id("layer"), "remove")),
				]),
				js.assign(id("curFxPoints"), js.arr()),
			]
		)
	);
	const clear = js.const_(
		CURSOR_FEEDBACK.clear,
		js.arrow(
			[],
			[
				js.expr(run("curFxClearTrail")),
				js.expr(run("curFxStop", id("curFxArt"))),
				js.expr(run("curFxStop", id("curFxGlow"))),
				js.assign(id("curFxArt"), js.nil()),
				js.assign(id("curFxGlow"), js.nil()),
				js.assign(id("curFxDown"), js.bool(false)),
			]
		)
	);
	// Quadratic edges make one closed shape, rather than a chain of uniform strokes.
	const edge = js.const_(
		"curFxEdge",
		js.arrow(
			["points", "start"],
			[
				js.let_("path", add(id("start"), pointText(at(id("points"), 0)))),
				js.let_("index", n(1)),
				js.while_(js.op(id("index"), "<", sub(js.member(id("points"), "length"), n(1))), [
					js.const_("point", at(id("points"), id("index"))),
					js.const_("next", at(id("points"), add(id("index"), n(1)))),
					js.assign(
						id("path"),
						add(
							id("path"),
							js.tpl(
								[" Q", " ", " ", ""],
								pointText(id("point")),
								div(add(at(id("point"), 0), at(id("next"), 0)), n(2)),
								div(add(at(id("point"), 1), at(id("next"), 1)), n(2))
							)
						)
					),
					js.assign(id("index"), add(id("index"), n(1))),
				]),
				js.ret(add(id("path"), add(s(" L"), pointText(call(id("points"), "at", n(-1)))))),
			]
		)
	);
	const ribbon = js.const_(
		"curFxRibbon",
		js.arrow(
			["points", "width"],
			[
				js.const_("left", js.arr()),
				js.const_("right", js.arr()),
				js.let_("index", n(0)),
				js.forOf("point", id("points"), [
					js.const_("before", at(id("points"), call(id("Math"), "max", n(0), sub(id("index"), n(1))))),
					js.const_(
						"after",
						at(
							id("points"),
							call(id("Math"), "min", sub(js.member(id("points"), "length"), n(1)), add(id("index"), n(1)))
						)
					),
					js.const_("dx", sub(at(id("after"), 0), at(id("before"), 0))),
					js.const_("dy", sub(at(id("after"), 1), at(id("before"), 1))),
					js.const_("length", js.or(call(id("Math"), "hypot", id("dx"), id("dy")), n(1))),
					js.const_(
						"taper",
						mul(
							div(id("width"), n(2)),
							call(
								id("Math"),
								"pow",
								div(id("index"), sub(js.member(id("points"), "length"), n(1))),
								n(E.taperPower)
							)
						)
					),
					js.const_("nx", mul(div(sub(n(0), id("dy")), id("length")), id("taper"))),
					js.const_("ny", mul(div(id("dx"), id("length")), id("taper"))),
					js.expr(
						call(
							id("left"),
							"push",
							js.arr(add(at(id("point"), 0), id("nx")), add(at(id("point"), 1), id("ny")))
						)
					),
					js.expr(
						call(
							id("right"),
							"unshift",
							js.arr(sub(at(id("point"), 0), id("nx")), sub(at(id("point"), 1), id("ny")))
						)
					),
					js.assign(id("index"), add(id("index"), n(1))),
				]),
				js.ret(
					add(add(run("curFxEdge", id("left"), s("M")), run("curFxEdge", id("right"), s(" L"))), s(" Z"))
				),
			]
		)
	);
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
	const trail = js.const_(
		"curFxDrawTrail",
		js.arrow(
			[],
			[
				js.let_("layer", run("curFxFind")),
				js.if_(js.not(id("layer")), [
					js.assign(id("layer"), svg("svg")),
					attr(id("layer"), "class", js.tpl(["", "e"], p.cls)),
					attr(
						id("layer"),
						"style",
						s(
							`position:fixed;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:${p.zIndex};`
						)
					),
					js.forOf(
						"band",
						js.arr(
							...E.bands.map((band) =>
								js.obj({ width: n(band.widthPx), opacity: n(band.opacity), blur: n(band.blurPx) })
							)
						),
						[
							js.const_("path", svg("path")),
							attr(id("path"), "fill", p.accent),
							attr(
								id("path"),
								"style",
								js.tpl(
									["opacity:", ";filter:blur(", "px);"],
									js.member(id("band"), "opacity"),
									js.member(id("band"), "blur")
								)
							),
							js.expr(call(id("layer"), "appendChild", id("path"))),
						]
					),
					js.expr(call(js.member(doc, "body"), "appendChild", id("layer"))),
				]),
				js.let_("index", n(0)),
				js.forOf("path", js.member(id("layer"), "children"), [
					attr(
						id("path"),
						"d",
						run(
							"curFxRibbon",
							id("curFxPoints"),
							at(js.arr(...E.bands.map((b) => n(b.widthPx))), id("index"))
						)
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
	const artwork = js.const_(
		"curFxArtwork",
		js.arrow(
			["cursor", "down", "motion"],
			[
				js.const_("art", call(id("cursor"), "querySelector", s("svg"))),
				js.if_(js.not(id("art")), [js.ret()]),
				js.const_("initial", js.op(id("art"), "!==", id("curFxArt"))),
				js.const_("changed", js.op(id("down"), "!==", id("curFxDown"))),
				js.assign(id("curFxArt"), id("art")),
				js.assign(js.member(id("art"), "style", "transformOrigin"), s(`${p.hotX}px ${p.hotY}px`)),
				js.assign(
					js.member(id("art"), "style", "transform"),
					js.cond(id("down"), scale(E.pressedScale), scale(1))
				),
				js.if_(js.not(id("motion")), [
					js.expr(run("curFxStop", id("art"))),
					js.expr(run("curFxStop", id("curFxGlow"))),
					js.if_(id("curFxGlow"), [js.assign(js.member(id("curFxGlow"), "style", "opacity"), s("0"))]),
					js.ret(),
				]),
				js.if_(js.or(js.not(id("changed")), js.and(id("initial"), js.not(id("down")))), [js.ret()]),
				js.expr(run("curFxStop", id("art"))),
				js.if_(js.op(js.member(id("art"), "childElementCount"), "===", n(2)), [
					js.const_("glow", call(js.member(id("art"), "lastElementChild"), "cloneNode", js.bool(true))),
					attr(id("glow"), "fill", p.accent),
					attr(id("glow"), "fill-opacity", s(String(E.contourFillOpacity))),
					attr(id("glow"), "stroke", p.accent),
					attr(id("glow"), "stroke-width", s(String(E.contourWidthPx))),
					attr(id("glow"), "stroke-linejoin", s("round")),
					js.assign(js.member(id("glow"), "style", "opacity"), s("0")),
					js.expr(call(id("art"), "appendChild", id("glow"))),
				]),
				js.assign(id("curFxGlow"), js.member(id("art"), "lastElementChild")),
				js.expr(run("curFxStop", id("curFxGlow"))),
				js.assign(
					js.member(id("curFxGlow"), "style", "opacity"),
					js.cond(id("down"), s(String(E.heldContourOpacity)), s("0"))
				),
				js.if_(
					id("down"),
					[
						js.expr(
							call(
								id("art"),
								"animate",
								js.arr(
									js.obj({ transform: scale(1) }),
									js.obj({ transform: scale(E.pressDipScale), offset: n(0.55) }),
									js.obj({ transform: scale(E.pressedScale) })
								),
								js.obj({ duration: n(E.pressMs), easing: s(E.pressEasing) })
							)
						),
						js.expr(
							call(
								id("curFxGlow"),
								"animate",
								js.arr(
									js.obj({ opacity: n(0) }),
									js.obj({ opacity: n(E.pressContourOpacity), offset: n(0.4) }),
									js.obj({ opacity: n(E.heldContourOpacity) })
								),
								js.obj({ duration: n(E.pressMs), easing: s("ease-out") })
							)
						),
					],
					[
						js.expr(
							call(
								id("art"),
								"animate",
								js.arr(
									js.obj({ transform: scale(E.pressedScale) }),
									js.obj({ transform: scale(E.releaseSettleScale), offset: n(0.45) }),
									js.obj({ transform: scale(1) })
								),
								js.obj({ duration: n(E.releaseMs), easing: s(E.releaseEasing) })
							)
						),
						js.expr(
							call(
								id("curFxGlow"),
								"animate",
								js.arr(
									js.obj({ opacity: n(E.heldContourOpacity) }),
									js.obj({ opacity: n(E.releaseContourOpacity), offset: n(0.2) }),
									js.obj({ opacity: n(0) })
								),
								js.obj({ duration: n(E.contourReleaseMs), easing: s("ease-out") })
							)
						),
					]
				),
			]
		)
	);
	const update = js.const_(
		CURSOR_FEEDBACK.update,
		js.arrow(
			["q", "cursor"],
			[
				js.const_(
					"point",
					js.arr(
						add(js.member(id("q"), W.x), n(E.rearOffsetX)),
						add(js.member(id("q"), W.y), n(E.rearOffsetY))
					)
				),
				js.const_("down", js.not(js.not(js.member(id("q"), W.down)))),
				js.const_(
					"motion",
					js.and(
						js.op(js.typeof_(js.member(doc, "documentElement", "animate")), "===", s("function")),
						js.not(
							js.and(
								js.member(id("window"), "matchMedia"),
								js.member(
									call(id("window"), "matchMedia", s(HIGHLIGHT_MOTION.reducedMotionQuery)),
									"matches"
								)
							)
						)
					)
				),
				js.expr(run("curFxArtwork", id("cursor"), id("down"), id("motion"))),
				js.assign(id("curFxDown"), id("down")),
				js.if_(js.not(id("motion")), [js.expr(run("curFxClearTrail")), js.ret()]),
				js.const_("previous", call(id("curFxPoints"), "at", n(-1))),
				js.if_(js.not(id("previous")), [
					js.expr(call(id("curFxPoints"), "push", id("point"))),
					js.ret(),
				]),
				js.const_("distance", distance(id("point"), id("previous"))),
				js.if_(js.op(id("distance"), ">", n(E.jumpDistancePx)), [
					js.expr(run("curFxClearTrail")),
					js.expr(call(id("curFxPoints"), "push", id("point"))),
					js.ret(),
				]),
				js.if_(js.op(id("distance"), "<", n(E.minDistancePx)), [js.ret()]),
				js.expr(call(id("curFxPoints"), "push", id("point"))),
				js.expr(run("curFxTrim")),
				js.expr(run("curFxDrawTrail")),
			]
		)
	);
	return [
		js.let_("curFxPoints", js.arr()),
		js.let_("curFxDown", js.bool(false)),
		js.let_("curFxArt", js.nil()),
		js.let_("curFxGlow", js.nil()),
		js.let_("curFxTrailAnimation", js.nil()),
		stop,
		find,
		clearTrail,
		clear,
		edge,
		ribbon,
		trim,
		trail,
		artwork,
		update,
	];
}
