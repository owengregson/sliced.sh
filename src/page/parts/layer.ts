// src/page/parts/layer.ts
/**
 * The board-layer lifecycle both SVG layers share — the recommendation mark
 * (`highlight-overlay.ts`, prefix `ov`) and the board effects (`effects-overlay.ts`, prefix
 * `ef`): locate the host through the bound selector ladder, find the layer by its per-build
 * class (no `window` property, §13.3 rule 3), insert it on first use, map a square to its
 * on-screen cell, and fade it out on clear. Each builder declares one named routine in the
 * enclosing closure; the names are the caller's, so two layers can live in one program.
 */

import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { type Expression, js, type Statement } from "@pagescript";
import { callm, id, invoke, n, run, s, sub } from "./ast";
import { canAnimate } from "./motion";
import { setAttr, svgEl } from "./svg";

/** `const <name> = () => { for (const <each> of hosts) { const el = document.querySelector(<each>); if (el) return el; } return null; };` */
export function hostLadder(name: string, hosts: Expression, each: string): Statement {
	const el = id("el");
	return js.const_(
		name,
		js.arrow(
			[],
			[
				js.forOf(each, hosts, [
					js.const_("el", callm(id("document"), "querySelector", id(each))),
					js.if_(el, [js.ret(el)]),
				]),
				js.ret(js.nil()),
			]
		)
	);
}

/** `const <name> = () => { const host = <host>(); if (!host) return null; return host.querySelector("." + cls); };` */
export function layerFind(name: string, host: string, cls: Expression): Statement {
	const h = id("host");
	return js.const_(
		name,
		js.arrow(
			[],
			[
				js.const_("host", run(host)),
				js.if_(js.not(h), [js.ret(js.nil())]),
				js.ret(callm(h, "querySelector", js.op(s("."), "+", cls))),
			]
		)
	);
}

/** The layer, inserting its `<svg viewBox="0 0 8 8">` into the host the first time. */
export function layerEnsure(
	name: string,
	refs: { find: string; host: string },
	cls: Expression,
	style: string
): Statement {
	const el = id("el");
	const h = id("host");
	return js.const_(
		name,
		js.arrow(
			[],
			[
				js.let_("el", run(refs.find)),
				js.if_(el, [js.ret(el)]),
				js.const_("host", run(refs.host)),
				js.if_(js.not(h), [js.ret(js.nil())]),
				js.assign(el, svgEl("svg")),
				setAttr(el, "viewBox", s("0 0 8 8")),
				setAttr(el, "class", cls),
				setAttr(el, "style", s(style)),
				js.expr(callm(h, "appendChild", el)),
				js.ret(el),
			]
		)
	);
}

/** `const <name> = (sq, black) => [col, row]`: files a..h → 0..7, ranks 1..8 → 0..7, on screen. */
export function squareCell(name: string): Statement {
	const sq = id("sq");
	return js.const_(
		name,
		js.arrow(
			["sq", "black"],
			[
				js.const_("f", sub(callm(sq, "charCodeAt", n(0)), n(97))),
				js.const_("r", sub(callm(sq, "charCodeAt", n(1)), n(49))),
				js.ret(
					js.cond(id("black"), js.arr(sub(n(7), id("f")), id("r")), js.arr(id("f"), sub(n(7), id("r"))))
				),
			]
		)
	);
}

/**
 * The clear's fade: the layer is first renamed out of `find`'s reach — so a draw that follows
 * at once gets a fresh layer and the fading one cannot be mistaken for it — and a fade to
 * transparent removes it when done. Without motion it is removed on the spot.
 */
export function fadeOutLayer(find: string, cls: Expression): Statement[] {
	const el = id("el");
	const remove = (): Statement[] => [invoke(el, "remove")];
	return [
		js.const_("el", run(find)),
		js.if_(el, [
			js.expr(callm(el, "setAttribute", s("class"), js.op(cls, "+", s("-out")))),
			js.const_("motion", canAnimate(el, s(HIGHLIGHT_MOTION.reducedMotionQuery))),
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
							js.arrow([], remove()),
							js.arrow([], remove())
						)
					),
				],
				remove()
			),
		]),
	];
}
