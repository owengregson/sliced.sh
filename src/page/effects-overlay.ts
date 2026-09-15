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

import {
	BOARD_EFFECT_GEOMETRY as G,
	BOARD_EFFECT_LIMITS as L,
	BOARD_EFFECT_MOTION as M,
	BOARD_EFFECT_SEIZE as Z,
} from "@core/constants/board-effects";
import { BRIDGE_ORIENTATION, BRIDGE_WIRE as W } from "@core/constants/bridge";
import { MOVE_QUALITY_ART as ART, MOVE_QUALITY as Q } from "@core/constants/move-quality";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { defineProgram, type Expression, js, type Statement } from "@pagescript";
import { arrowShapeStatements, arrowStubLength } from "./arrow-shape";
import { defineHandle, definePost, KINDS, listen, orEmpty, post } from "./bridge-common";

const SVG_NS = "http://www.w3.org/2000/svg";
const doc = js.id("document");
const id = js.id;
const n = js.num;
const s = js.str;

const add = (a: Expression, b: Expression): Expression => js.op(a, "+", b);
const sub = (a: Expression, b: Expression): Expression => js.op(a, "-", b);
const mul = (a: Expression, b: Expression): Expression => js.op(a, "*", b);
const callm = (o: Expression, method: string, ...args: Expression[]): Expression =>
	js.call(js.member(o, method), ...args);
const svg = (tag: string): Expression => callm(doc, "createElementNS", s(SVG_NS), s(tag));
const attr = (el: Expression, name: string, value: Expression): Statement =>
	js.expr(callm(el, "setAttribute", s(name), value));
const text = (v: Expression): Expression => js.call(id("String"), v);

/** One effect group's life, and where its hold ends inside it. */
const LIFE = M.drawMs + M.holdMs + M.fadeMs;
const HOLD_END = (M.drawMs + M.holdMs) / LIFE;
/** Chip life, and the four stops of its scale/fade. */
const CHIP_LIFE = Q.chipInMs + Q.chipHoldMs + Q.chipOutMs;
const CHIP_OVERSHOOT = (Q.chipInMs * 0.72) / CHIP_LIFE;
const CHIP_SETTLED = Q.chipInMs / CHIP_LIFE;
const CHIP_HELD = (Q.chipInMs + Q.chipHoldMs) / CHIP_LIFE;
/** The stub the arrow draw grows from, at the layer's arrow scale. */
const ARROW_STUB = arrowStubLength(G.arrowScale);
const OVERLAY_STYLE = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${G.zIndex}`;
const CHIP_ORIGIN = `transform-origin:${ART.originX}px ${ART.originY}px`;
/** The seize outline scales about the captured square's centre, the origin of its own group. */
const SEIZE_ORIGIN = "transform-origin:0px 0px";

export const EFFECTS = {
	draw: "efDraw",
	clear: "efClear",
} as const;

export interface EffectsParams {
	/** Selector ladder (json array) locating the host element. */
	hosts: Expression;
	/** The per-build class name of the layer's `<svg>`. */
	cls: Expression;
	/** `{ mine, theirs, edge }` — one colour per side, and the arrow shadow's tint. */
	palette: Expression;
	/** `BOARD_EFFECT_STYLES` as a json table, keyed by the wire letter. */
	styles: Expression;
	/** `MOVE_QUALITY_ICONS` as a json array, indexed by the wire index. */
	icons: Expression;
}

/** `typeof el.animate === "function" && !matchMedia(reduced).matches` */
function motionTest(el: Expression): Expression {
	return js.and(
		js.op(js.typeof_(js.member(el, "animate")), "===", s("function")),
		js.not(
			js.and(
				js.member(id("window"), "matchMedia"),
				js.member(
					js.call(js.member(id("window"), "matchMedia"), s(HIGHLIGHT_MOTION.reducedMotionQuery)),
					"matches"
				)
			)
		)
	);
}

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
	const el = id("el");
	const host = id("host");
	const sq = id("sq");
	const black = id("black");
	const st = id("st");
	const group = id("group");
	const live = id("efLive");
	const chips = id("efChips");
	const entry = id("entry");

	/** Cancel an entry's animations and take its node off the layer. */
	const efDrop = js.const_(
		"efDrop",
		js.arrow(
			["entry"],
			[
				js.forOf("animation", js.member(entry, "anims"), [js.expr(callm(id("animation"), "cancel"))]),
				js.assign(js.member(entry, "anims", "length"), n(0)),
				js.expr(callm(js.member(entry, "node"), "remove")),
			]
		)
	);
	/** Forget a node that removed itself. */
	const efForget = js.const_(
		"efForget",
		js.arrow(
			["list", "node"],
			[
				js.const_(
					"at",
					callm(
						id("list"),
						"findIndex",
						js.arrow(["entry"], [js.ret(js.op(js.member(entry, "node"), "===", id("node")))])
					)
				),
				js.if_(js.op(id("at"), ">=", n(0)), [js.expr(callm(id("list"), "splice", id("at"), n(1)))]),
			]
		)
	);
	/** Evict the oldest entries beyond `max`. */
	const efTrim = js.const_(
		"efTrim",
		js.arrow(
			["list", "max"],
			[
				js.while_(js.op(js.member(id("list"), "length"), ">", id("max")), [
					js.expr(js.call(id("efDrop"), callm(id("list"), "shift"))),
				]),
			]
		)
	);
	const flush = (list: Expression): Statement =>
		js.forOf("entry", callm(list, "splice", n(0)), [js.expr(js.call(id("efDrop"), entry))]);
	const forgetOnFinish = (animation: Expression, list: Expression, node: Expression): Statement =>
		js.expr(
			callm(
				js.member(animation, "finished"),
				"then",
				js.arrow([], [js.expr(callm(node, "remove")), js.expr(js.call(id("efForget"), list, node))]),
				js.arrow([], [])
			)
		);

	const efAnimate = js.const_(
		"efAnimate",
		js.arrow(
			["node", "frames", "options", "into"],
			[
				js.const_("animation", callm(id("node"), "animate", id("frames"), id("options"))),
				js.expr(callm(id("into"), "push", id("animation"))),
				js.ret(id("animation")),
			]
		)
	);
	const efHost = js.const_(
		"efHost",
		js.arrow(
			[],
			[
				js.forOf("selector", p.hosts, [
					js.const_("el", callm(doc, "querySelector", id("selector"))),
					js.if_(el, [js.ret(el)]),
				]),
				js.ret(js.nil()),
			]
		)
	);
	const efFind = js.const_(
		"efFind",
		js.arrow(
			[],
			[
				js.const_("host", js.call(id("efHost"))),
				js.if_(js.not(host), [js.ret(js.nil())]),
				js.ret(callm(host, "querySelector", js.op(s("."), "+", p.cls))),
			]
		)
	);
	const efEnsure = js.const_(
		"efEnsure",
		js.arrow(
			[],
			[
				js.let_("el", js.call(id("efFind"))),
				js.if_(el, [js.ret(el)]),
				js.const_("host", js.call(id("efHost"))),
				js.if_(js.not(host), [js.ret(js.nil())]),
				js.assign(el, svg("svg")),
				attr(el, "viewBox", s("0 0 8 8")),
				attr(el, "class", p.cls),
				attr(el, "style", s(OVERLAY_STYLE)),
				js.expr(callm(host, "appendChild", el)),
				js.ret(el),
			]
		)
	);
	// [col, row] of a square on screen: files a..h → 0..7, ranks 1..8 → 0..7
	const efCell = js.const_(
		"efCell",
		js.arrow(
			["sq", "black"],
			[
				js.const_("f", sub(callm(sq, "charCodeAt", n(0)), n(97))),
				js.const_("r", sub(callm(sq, "charCodeAt", n(1)), n(49))),
				js.ret(
					js.cond(black, js.arr(sub(n(7), id("f")), id("r")), js.arr(id("f"), sub(n(7), id("r"))))
				),
			]
		)
	);

	/**
	 * The arrow's bound colours: the fill it falls back to (every effect passes its own) and the
	 * shadow tint, both from the palette.
	 */
	const efArrowColors = js.const_(
		"efArrowColors",
		js.obj({ arrow: js.member(p.palette, "mine"), edge: js.member(p.palette, "edge") })
	);

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

	const efBadge = js.const_(
		"efBadge",
		js.arrow(
			["el", "chip", "black", "motion"],
			[
				js.const_("art", js.member(p.icons, js.member(id("chip"), W.badgeIndex))),
				js.if_(js.not(id("art")), [js.ret(js.bool(false))]),
				js.const_("square", js.member(id("chip"), W.square)),
				// Two chips on one square would blend into one unreadable disc (a recapture): the
				// earlier one goes. Chips on other squares keep running.
				js.forOf("old", callm(chips, "slice"), [
					js.if_(js.op(js.member(id("old"), "sq"), "===", id("square")), [
						js.expr(js.call(id("efDrop"), id("old"))),
						js.expr(js.call(id("efForget"), chips, js.member(id("old"), "node"))),
					]),
				]),
				js.const_("c", js.call(id("efCell"), id("square"), black)),
				js.const_("group", svg("g")),
				attr(
					id("group"),
					"transform",
					js.tpl(
						["translate(", " ", `) scale(${Q.chipSize / ART.viewBoxWidth})`],
						add(js.member(id("c"), n(0)), n(Q.chipAnchorX - Q.chipSize / 2)),
						add(js.member(id("c"), n(1)), n(Q.chipAnchorY - Q.chipSize / 2))
					)
				),
				js.const_("inner", svg("g")),
				attr(id("inner"), "style", s(CHIP_ORIGIN)),
				js.expr(callm(id("group"), "appendChild", id("inner"))),
				js.const_("rim", svg("path")),
				attr(id("rim"), "d", s(ART.circleShadow)),
				attr(id("rim"), "fill", s(ART.shadowFill)),
				attr(id("rim"), "opacity", s(String(ART.circleShadowOpacity))),
				js.expr(callm(id("inner"), "appendChild", id("rim"))),
				js.const_("disc", svg("path")),
				attr(id("disc"), "d", s(ART.circleBackground)),
				attr(id("disc"), "fill", js.member(id("art"), "background")),
				js.expr(callm(id("inner"), "appendChild", id("disc"))),
				js.const_("under", svg("g")),
				attr(id("under"), "transform", s(`translate(0 ${ART.glyphShadowShift})`)),
				attr(id("under"), "fill", s(ART.shadowFill)),
				attr(id("under"), "opacity", s(String(ART.glyphShadowOpacity))),
				js.expr(callm(id("inner"), "appendChild", id("under"))),
				js.const_("face", svg("g")),
				attr(id("face"), "fill", s(ART.glyphFill)),
				js.expr(callm(id("inner"), "appendChild", id("face"))),
				js.forOf("d", orEmpty(js.member(id("art"), "glyph")), [
					js.const_("below", svg("path")),
					attr(id("below"), "d", id("d")),
					js.expr(callm(id("under"), "appendChild", id("below"))),
					js.const_("above", svg("path")),
					attr(id("above"), "d", id("d")),
					js.expr(callm(id("face"), "appendChild", id("above"))),
				]),
				js.if_(js.not(id("motion")), [attr(id("inner"), "opacity", s(String(Q.chipOpacity)))]),
				js.expr(callm(el, "appendChild", id("group"))),
				js.const_("entry", js.obj({ node: id("group"), sq: id("square"), anims: js.arr() })),
				js.expr(callm(chips, "push", entry)),
				js.expr(js.call(id("efTrim"), chips, n(L.maxLiveChips))),
				js.if_(id("motion"), [
					js.const_(
						"run",
						js.call(
							id("efAnimate"),
							id("inner"),
							js.arr(
								js.obj({
									opacity: n(0),
									transform: s(`scale(${Q.chipScaleFrom})`),
									offset: n(0),
									easing: s(Q.chipEasing),
								}),
								js.obj({
									opacity: n(Q.chipOpacity),
									transform: s(`scale(${Q.chipScalePeak})`),
									offset: n(CHIP_OVERSHOOT),
								}),
								js.obj({
									opacity: n(Q.chipOpacity),
									transform: s("scale(1)"),
									offset: n(CHIP_SETTLED),
								}),
								js.obj({ opacity: n(Q.chipOpacity), transform: s("scale(1)"), offset: n(CHIP_HELD) }),
								js.obj({ opacity: n(0), transform: s(`scale(${Q.chipScaleOut})`), offset: n(1) })
							),
							js.obj({ duration: n(CHIP_LIFE), fill: s("forwards") }),
							js.member(entry, "anims")
						)
					),
					forgetOnFinish(id("run"), chips, id("group")),
				]),
				js.ret(js.bool(true)),
			]
		)
	);

	// A batch adds to the layer; it never replaces what is still animating. The rays are drawn
	// once per distinct batch (the verdict command repeats the list beside the chip, and a
	// republished position repeats it entirely), and the chip once per distinct verdict — keyed
	// with `mine` so a recapture's chip on the same square with the same verdict still shows.
	// Without motion nothing removes itself, so the next distinct batch replaces the layer.
	const efDraw = js.const_(
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
				js.if_(js.op(id("efMark"), "!==", id("mark")), [
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
				]),
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

	// A clear fades the layer out rather than snapping it away, exactly as the recommendation mark
	// does: the element is first renamed out of `efFind`'s reach — so a batch that follows at once
	// gets a fresh layer and the fading one cannot be mistaken for it — and a fade to transparent
	// removes it when done. Without motion it is removed on the spot. The entries go with the
	// element (their animations finish under the fade and their removals find nothing to do).
	const efClear = js.const_(
		EFFECTS.clear,
		js.arrow(
			[],
			[
				js.assign(js.member(live, "length"), n(0)),
				js.assign(js.member(chips, "length"), n(0)),
				js.assign(id("efMark"), js.nil()),
				js.assign(id("efChipMark"), js.nil()),
				js.assign(id("efElement"), js.nil()),
				js.const_("el", js.call(id("efFind"))),
				js.if_(el, [
					js.expr(callm(el, "setAttribute", s("class"), js.op(p.cls, "+", s("-out")))),
					js.const_("motion", motionTest(el)),
					js.if_(
						id("motion"),
						[
							js.const_(
								"out",
								callm(
									el,
									"animate",
									js.arr(js.obj({ opacity: n(1) }), js.obj({ opacity: n(0) })),
									js.obj({
										duration: n(HIGHLIGHT_MOTION.clearFadeMs),
										easing: s("ease-out"),
										fill: s("forwards"),
									})
								)
							),
							js.expr(
								callm(
									js.member(id("out"), "finished"),
									"then",
									js.arrow([], [js.expr(callm(el, "remove"))]),
									js.arrow([], [js.expr(callm(el, "remove"))])
								)
							),
						],
						[js.expr(callm(el, "remove"))]
					),
				]),
			]
		)
	);

	return [
		js.const_("efLive", js.arr()),
		js.const_("efChips", js.arr()),
		js.let_("efMark", js.nil()),
		js.let_("efChipMark", js.nil()),
		js.let_("efElement", js.nil()),
		efDrop,
		efForget,
		efTrim,
		efAnimate,
		efHost,
		efFind,
		efEnsure,
		efCell,
		efArrowColors,
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
		efArrowEffect,
		efSeize,
		efEffect,
		efBadge,
		efDraw,
		efClear,
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
