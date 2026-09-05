// src/page/highlight-overlay.ts
/**
 * `highlight-overlay` (§5.5, Appendix C §2.7): the generic from/to-square +
 * arrow overlay used when native drawing is unavailable — lichess round
 * pages always, chess.com only when `game.markings` is missing.
 *
 * Presence rules (§13.3 rule 3): the overlay inserts nothing until a `draw`
 * command arrives; the one `<svg viewBox="0 0 8 8">` it appends goes to the
 * host (`cg-container`, or `wc-chess-board`) with `pointer-events: none`,
 * never inside `svg.cg-shapes`; it is idempotent by looking its own
 * per-build class up in the DOM (no `window` property); it carries no `id`,
 * `data-*` or text. Colours come from the payload (the adapter reads
 * `TOKENS`), with the bound `colors` (also from `TOKENS`) as the fallback.
 *
 * `overlayStatements` is the reusable builder the two bridges embed; the
 * standalone program below is the same overlay driven by its own message
 * listener (non-entry: generated as a module only).
 */

import { BRIDGE_ORIENTATION, BRIDGE_WIRE as W } from "@core/constants/bridge";
import { defineProgram, type Expression, js, type Statement } from "@pagescript";
import { defineHandle, definePost, KINDS, listen, orEmpty, post } from "./bridge-common";

const SVG_NS = "http://www.w3.org/2000/svg";
const doc = js.id("document");

export const OVERLAY = {
	draw: "ovDraw",
	clear: "ovClear",
} as const;

/** Arrow geometry in board units (one square = 1). */
const ARROW = {
	shaftHalfWidth: 0.11,
	headHalfWidth: 0.3,
	headLength: 0.4,
	startInset: 0.25,
} as const;

const n = js.num;
const num = (v: Expression): Expression => js.call(js.id("String"), v);
const add = (a: Expression, b: Expression): Expression => js.op(a, "+", b);
const sub = (a: Expression, b: Expression): Expression => js.op(a, "-", b);
const mul = (a: Expression, b: Expression): Expression => js.op(a, "*", b);

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
	/** `{ from, to, arrow }` fallback colours. */
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
	const at = (v: Expression, i: number): Expression => js.member(v, js.num(i));
	const pt = (x: Expression, y: Expression): Expression => add(add(num(x), js.str(",")), num(y));
	const ovDraw = js.const_(
		OVERLAY.draw,
		js.arrow(
			["q"],
			[
				js.const_("el", js.call(js.id("ovEnsure"))),
				js.if_(js.not(el), [js.ret()]),
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
				]),
				js.forOf("a", orEmpty(js.member(q, W.arrows)), [
					js.const_("s", js.call(js.id("ovCell"), js.member(a, W.from), black)),
					js.const_("e", js.call(js.id("ovCell"), js.member(a, W.to), black)),
					js.const_("x1", add(at(js.id("s"), 0), n(0.5))),
					js.const_("y1", add(at(js.id("s"), 1), n(0.5))),
					js.const_("x2", add(at(js.id("e"), 0), n(0.5))),
					js.const_("y2", add(at(js.id("e"), 1), n(0.5))),
					js.const_("dx", sub(js.id("x2"), js.id("x1"))),
					js.const_("dy", sub(js.id("y2"), js.id("y1"))),
					js.const_(
						"len",
						js.or(js.call(js.member(js.id("Math"), "hypot"), js.id("dx"), js.id("dy")), n(1))
					),
					js.const_("ux", js.op(js.id("dx"), "/", js.id("len"))),
					js.const_("uy", js.op(js.id("dy"), "/", js.id("len"))),
					js.const_("px", js.op(js.num(0), "-", js.id("uy"))),
					js.const_("py", js.id("ux")),
					// shaft start (inset from the centre) and head base
					js.const_("bx", add(js.id("x1"), mul(js.id("ux"), n(ARROW.startInset)))),
					js.const_("by", add(js.id("y1"), mul(js.id("uy"), n(ARROW.startInset)))),
					js.const_("hx", sub(js.id("x2"), mul(js.id("ux"), n(ARROW.headLength)))),
					js.const_("hy", sub(js.id("y2"), mul(js.id("uy"), n(ARROW.headLength)))),
					js.const_("w", n(ARROW.shaftHalfWidth)),
					js.const_("hw", n(ARROW.headHalfWidth)),
					js.const_(
						"pts",
						js.call(
							js.member(
								js.arr(
									pt(
										add(js.id("bx"), mul(js.id("px"), js.id("w"))),
										add(js.id("by"), mul(js.id("py"), js.id("w")))
									),
									pt(
										add(js.id("hx"), mul(js.id("px"), js.id("w"))),
										add(js.id("hy"), mul(js.id("py"), js.id("w")))
									),
									pt(
										add(js.id("hx"), mul(js.id("px"), js.id("hw"))),
										add(js.id("hy"), mul(js.id("py"), js.id("hw")))
									),
									pt(js.id("x2"), js.id("y2")),
									pt(
										sub(js.id("hx"), mul(js.id("px"), js.id("hw"))),
										sub(js.id("hy"), mul(js.id("py"), js.id("hw")))
									),
									pt(
										sub(js.id("hx"), mul(js.id("px"), js.id("w"))),
										sub(js.id("hy"), mul(js.id("py"), js.id("w")))
									),
									pt(
										sub(js.id("bx"), mul(js.id("px"), js.id("w"))),
										sub(js.id("by"), mul(js.id("py"), js.id("w")))
									)
								),
								"join"
							),
							js.str(" ")
						)
					),
					js.const_("pg", createSvg("polygon")),
					setAttr(js.id("pg"), "points", js.id("pts")),
					setAttr(js.id("pg"), "fill", js.or(js.member(a, W.color), js.member(p.colors, "arrow"))),
					js.expr(js.call(js.member(el, "appendChild"), js.id("pg"))),
				]),
			]
		)
	);
	const ovClear = js.const_(
		OVERLAY.clear,
		js.arrow(
			[],
			[
				js.const_("el", js.call(js.id("ovFind"))),
				js.if_(el, [js.expr(js.call(js.member(el, "remove")))]),
			]
		)
	);
	return [ovHost, ovFind, ovEnsure, ovCell, ovDraw, ovClear];
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
