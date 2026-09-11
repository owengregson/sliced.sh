// src/page/highlight-overlay.ts
/**
 * `highlight-overlay` (§5.5): the generic from/to-square + arrow overlay used
 * for recommendation feedback. Our SVG survives board presses and supports a
 * one-shot drawing arrow plus square fade; native markings cannot animate.
 *
 * Presence rules (§13.3 rule 3): the overlay inserts nothing until a `draw`
 * command arrives; the one `<svg viewBox="0 0 8 8">` it appends goes to the
 * board host with `pointer-events: none`; it is idempotent by looking its own
 * per-build class up in the DOM (no `window` property); its root carries no `id`,
 * `data-*` or text. Gradient paint IDs are scoped to its per-build class. Colours come from the payload (the adapter reads
 * `TOKENS`), with the bound `colors` (also from `TOKENS`) as the fallback.
 *
 * `overlayStatements` is the reusable builder the bridge embeds; the
 * standalone program below is the same overlay driven by its own message
 * listener (non-entry: generated as a module only).
 */

import { BRIDGE_ORIENTATION, BRIDGE_WIRE as W } from "@core/constants/bridge";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { defineProgram, type Expression, js, type Statement } from "@pagescript";
import { arrowShapeStatements } from "./arrow-shape";
import { defineHandle, definePost, KINDS, listen, orEmpty, post } from "./bridge-common";

const SVG_NS = "http://www.w3.org/2000/svg";
const doc = js.id("document");

export const OVERLAY = {
	draw: "ovDraw",
	clear: "ovClear",
} as const;

const n = js.num;
const num = (v: Expression): Expression => js.call(js.id("String"), v);
const add = (a: Expression, b: Expression): Expression => js.op(a, "+", b);
const sub = (a: Expression, b: Expression): Expression => js.op(a, "-", b);

function setAttr(el: Expression, name: string, value: Expression): Statement {
	return js.expr(js.call(js.member(el, "setAttribute"), js.str(name), value));
}

function createSvg(tag: string): Expression {
	return js.call(js.member(doc, "createElementNS"), js.str(SVG_NS), js.str(tag));
}

export interface OverlayParams {
	/** Selector ladder (json array) locating the host element. */
	hosts: Expression;
	/** The per-build class name of the overlay `<svg>`. */
	cls: Expression;
	/** `{ from, to, arrow, edge }` fallback colours and soft shadow tint. */
	colors: Expression;
}

/**
 * Declares, inside the enclosing closure:
 *   `ovHost()`  — first host the ladder matches
 *   `ovFind()`  — the existing overlay (DOM lookup by class), or null
 *   `ovDraw(q)` — (re)draw from a wire payload `{ r, h: [{q, c}], a: [{f, t, c}] }`
 *   `ovClear()` — remove the overlay
 */
export function overlayStatements(p: OverlayParams): Statement[] {
	const el = js.id("el");
	const host = js.id("host");
	const sq = js.id("sq");
	const black = js.id("black");
	const q = js.id("q");
	const animations = js.id("ovAnimations");
	const fadeStart = HIGHLIGHT_MOTION.arrowDrawMs + HIGHLIGHT_MOTION.arrowHoldMs;
	const duration = fadeStart + HIGHLIGHT_MOTION.arrowFadeMs;
	const ovStop = js.const_(
		"ovStop",
		js.arrow(
			[],
			[
				js.forOf("animation", animations, [js.expr(js.call(js.member(js.id("animation"), "cancel")))]),
				js.assign(animations, js.arr()),
			]
		)
	);
	const ovAnimate = js.const_(
		"ovAnimate",
		js.arrow(
			["node", "frames", "options"],
			[
				js.const_(
					"animation",
					js.call(js.member(js.id("node"), "animate"), js.id("frames"), js.id("options"))
				),
				js.expr(js.call(js.member(animations, "push"), js.id("animation"))),
				js.ret(js.id("animation")),
			]
		)
	);

	const ovHost = js.const_(
		"ovHost",
		js.arrow(
			[],
			[
				js.forOf("s", p.hosts, [
					js.const_("el", js.call(js.member(doc, "querySelector"), js.id("s"))),
					js.if_(el, [js.ret(el)]),
				]),
				js.ret(js.nil()),
			]
		)
	);
	const ovFind = js.const_(
		"ovFind",
		js.arrow(
			[],
			[
				js.const_("host", js.call(js.id("ovHost"))),
				js.if_(js.not(host), [js.ret(js.nil())]),
				js.ret(js.call(js.member(host, "querySelector"), js.op(js.str("."), "+", p.cls))),
			]
		)
	);
	const ovEnsure = js.const_(
		"ovEnsure",
		js.arrow(
			[],
			[
				js.let_("el", js.call(js.id("ovFind"))),
				js.if_(el, [js.ret(el)]),
				js.const_("host", js.call(js.id("ovHost"))),
				js.if_(js.not(host), [js.ret(js.nil())]),
				js.assign(el, createSvg("svg")),
				setAttr(el, "viewBox", js.str("0 0 8 8")),
				setAttr(el, "class", p.cls),
				setAttr(
					el,
					"style",
					js.str("position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3")
				),
				js.expr(js.call(js.member(host, "appendChild"), el)),
				js.ret(el),
			]
		)
	);
	// [col, row] of a square on screen: files a..h → 0..7, ranks 1..8 → 0..7
	const ovCell = js.const_(
		"ovCell",
		js.arrow(
			["sq", "black"],
			[
				js.const_("f", sub(js.call(js.member(sq, "charCodeAt"), n(0)), n(97))),
				js.const_("r", sub(js.call(js.member(sq, "charCodeAt"), n(1)), n(49))),
				js.ret(
					js.cond(
						black,
						js.arr(sub(n(7), js.id("f")), js.id("r")),
						js.arr(js.id("f"), sub(n(7), js.id("r")))
					)
				),
			]
		)
	);
	const c = js.id("c");
	const rc = js.id("rc");
	const h = js.id("h");
	const a = js.id("a");
	const cell = (i: number): Expression => js.member(c, js.num(i));
	const ovDraw = js.const_(
		OVERLAY.draw,
		js.arrow(
			["q"],
			[
				js.const_("el", js.call(js.id("ovEnsure"))),
				js.if_(js.not(el), [js.ret()]),
				js.const_(
					"mark",
					js.call(
						js.member(js.id("JSON"), "stringify"),
						js.arr(js.member(q, W.orientation), js.member(q, W.highlights), js.member(q, W.arrows))
					)
				),
				js.if_(
					js.and(
						js.op(js.id("ovLastElement"), "===", el),
						js.op(js.id("ovLastMark"), "===", js.id("mark"))
					),
					[js.ret()]
				),
				js.assign(js.id("ovLastElement"), el),
				js.assign(js.id("ovLastMark"), js.id("mark")),
				js.expr(js.call(js.id("ovStop"))),
				js.const_(
					"motion",
					js.and(
						js.op(js.typeof_(js.member(el, "animate")), "===", js.str("function")),
						js.not(
							js.and(
								js.member(js.id("window"), "matchMedia"),
								js.member(
									js.call(
										js.member(js.id("window"), "matchMedia"),
										js.str(HIGHLIGHT_MOTION.reducedMotionQuery)
									),
									"matches"
								)
							)
						)
					)
				),
				js.while_(js.member(el, "firstChild"), [
					js.expr(js.call(js.member(el, "removeChild"), js.member(el, "firstChild"))),
				]),
				js.const_("black", js.op(js.member(q, W.orientation), "===", js.str(BRIDGE_ORIENTATION.black))),
				// highlights arrive as [from, to]: the fallback colour follows that order
				js.let_("n", n(0)),
				js.forOf("h", orEmpty(js.member(q, W.highlights)), [
					js.const_("c", js.call(js.id("ovCell"), js.member(h, W.square), black)),
					js.const_("rc", createSvg("rect")),
					setAttr(rc, "x", num(cell(0))),
					setAttr(rc, "y", num(cell(1))),
					setAttr(rc, "width", js.str("1")),
					setAttr(rc, "height", js.str("1")),
					setAttr(
						rc,
						"fill",
						js.or(
							js.member(h, W.color),
							js.cond(
								js.op(js.id("n"), "===", n(0)),
								js.member(p.colors, "from"),
								js.member(p.colors, "to")
							)
						)
					),
					js.assign(js.id("n"), add(js.id("n"), n(1))),
					js.expr(js.call(js.member(el, "appendChild"), rc)),
					js.if_(js.id("motion"), [
						js.const_(
							"fade",
							js.call(
								js.id("ovAnimate"),
								rc,
								js.arr(
									js.obj({ opacity: n(0), offset: n(0), easing: js.str("ease-out") }),
									js.obj({ opacity: n(1), offset: n(HIGHLIGHT_MOTION.squareInMs / duration) }),
									js.obj({ opacity: n(1), offset: n(fadeStart / duration) }),
									js.obj({ opacity: n(0), offset: n(1) })
								),
								js.obj({ duration: n(duration), fill: js.str("forwards") })
							)
						),
						js.expr(
							js.call(
								js.member(js.id("fade"), "finished", "then"),
								js.arrow([], [js.expr(js.call(js.member(rc, "remove")))]),
								js.arrow([], [])
							)
						),
					]),
				]),
				js.forOf("a", orEmpty(js.member(q, W.arrows)), [
					js.expr(js.call(js.id("ovArrow"), el, a, black, js.id("motion"))),
				]),
			]
		)
	);
	const ovClear = js.const_(
		OVERLAY.clear,
		js.arrow(
			[],
			[
				js.expr(js.call(js.id("ovStop"))),
				js.assign(js.id("ovLastMark"), js.nil()),
				js.assign(js.id("ovLastElement"), js.nil()),
				js.const_("el", js.call(js.id("ovFind"))),
				js.if_(el, [js.expr(js.call(js.member(el, "remove")))]),
			]
		)
	);
	return [
		js.let_("ovAnimations", js.arr()),
		js.let_("ovLastMark", js.nil()),
		js.let_("ovLastElement", js.nil()),
		ovStop,
		ovAnimate,
		ovHost,
		ovFind,
		ovEnsure,
		ovCell,
		...arrowShapeStatements({ cls: p.cls, colors: p.colors }),
		ovDraw,
		ovClear,
	];
}

/** `ovDraw(payload)` / `ovClear()` as statements. */
export const overlay = {
	draw: (payload: Expression): Statement => js.expr(js.call(js.id(OVERLAY.draw), payload)),
	clear: (): Statement => js.expr(js.call(js.id(OVERLAY.clear))),
};

/**
 * Standalone overlay program: listens for `draw` / `clear` from the content
 * script and answers each with its id. Parameters are bound by the caller
 * (`token` / `peer` are the seed-derived direction tokens).
 */
export const highlightOverlay = defineProgram({
	name: "highlight-overlay",
	params: {
		token: "string",
		peer: "string",
		hosts: "json",
		cls: "string",
		colors: "json",
	},
	build: (p) =>
		js.program([
			definePost(p.token),
			...overlayStatements({ hosts: p.hosts, cls: p.cls, colors: p.colors }),
			defineHandle([
				{
					kind: KINDS.draw,
					body: [overlay.draw(js.id("q")), post(KINDS.draw, js.id("i"), js.obj({ [W.keys]: js.arr() }))],
				},
				{ kind: KINDS.clear, body: [overlay.clear(), post(KINDS.clear, js.id("i"), js.nil())] },
			]),
			listen(p.peer),
		]),
});
