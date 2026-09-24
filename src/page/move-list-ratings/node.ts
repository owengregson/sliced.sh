// src/page/move-list-ratings/node.ts
/**
 * One move-list node: `mlNorm(text)` reduces a SAN (figurines, annotations, castling zeros) to
 * the comparable form, and `mlNode(node)` checks the node's move against the row the content
 * script rated, then paints the text and inserts (or keeps) the verdict badge before it.
 */

import { type Expression, js, type Statement } from "@pagescript";
import { callm as call, id, invoke } from "../parts/ast";
import { setAttr as attr, svgEl as svg } from "../parts/svg";

const m = js.member;

/** `mlNorm` and `mlNode`, in that order. */
export function nodeRoutines(
	cfg: (key: string) => Expression,
	cls: Expression,
	icons: Expression
): Statement[] {
	const node = id("node");
	const row = id("row");
	const badge = id("badge");
	return [
		js.const_(
			"mlNorm",
			js.arrow(
				["text"],
				[
					js.let_("out", js.str("")),
					js.forOf("ch", id("text"), [
						js.assign(id("out"), js.op(id("out"), "+", js.or(m(cfg("figurines"), id("ch")), id("ch")))),
					]),
					js.ret(
						call(
							call(
								id("out"),
								"replace",
								js.new_(id("RegExp"), js.str("[\\s?!½]"), js.str("g")),
								js.str("")
							),
							"replace",
							js.new_(id("RegExp"), js.str("0"), js.str("g")),
							js.str("O")
						)
					),
				]
			)
		),
		js.const_(
			"mlNode",
			js.arrow(
				["node"],
				[
					js.const_("key", js.or(call(node, "getAttribute", cfg("nodeAttr")), js.str(""))),
					js.const_(
						"row",
						js.cond(
							call(js.new_(id("RegExp"), js.str("^0-[0-9]+$")), "test", id("key")),
							call(id("mlRows"), "get", js.call(id("Number"), call(id("key"), "slice", js.num(2)))),
							js.undef()
						)
					),
					js.let_("badge", call(node, "querySelector", js.op(js.str("."), "+", cls))),
					js.const_("content", call(node, "querySelector", cfg("text"))),
					js.let_("san", js.str("")),
					js.if_(id("content"), [
						js.forOf("child", m(id("content"), "childNodes"), [
							js.assign(
								id("san"),
								js.op(
									id("san"),
									"+",
									js.cond(
										js.op(m(id("child"), "nodeType"), "===", js.num(1)),
										js.or(
											call(id("child"), "getAttribute", cfg("figurineAttr")),
											js.or(m(id("child"), "textContent"), js.str(""))
										),
										js.or(m(id("child"), "textContent"), js.str(""))
									)
								)
							),
						]),
					]),
					js.if_(
						js.or(
							js.not(row),
							js.op(js.call(id("mlNorm"), id("san")), "!==", js.call(id("mlNorm"), m(row, js.num(1))))
						),
						[
							js.if_(badge, [invoke(badge, "remove")]),
							js.if_(id("content"), [js.expr(js.call(id("mlRestore"), id("content")))]),
							invoke(id("mlSeen"), "delete", node),
							js.ret(),
						]
					),
					js.const_("index", m(row, js.num(2))),
					js.const_("art", m(icons, id("index"))),
					js.if_(js.not(id("art")), [js.ret()]),
					js.const_("identity", call(row, "join", js.str("|"))),
					js.const_("fresh", js.not(call(id("mlArrived"), "has", id("identity")))),
					js.expr(
						js.call(
							id("mlPaint"),
							id("content"),
							m(id("art"), "background"),
							js.and(id("fresh"), js.call(id("mlMotion"), id("content")))
						)
					),
					js.if_(js.and(badge, js.op(m(node, "firstChild"), "!==", badge)), [
						invoke(node, "insertBefore", badge, m(node, "firstChild")),
					]),
					js.if_(js.and(badge, js.op(call(id("mlSeen"), "get", node), "===", id("index"))), [js.ret()]),
					js.if_(badge, [invoke(badge, "remove")]),
					js.assign(badge, svg("svg")),
					attr(badge, "class", cls),
					attr(badge, "viewBox", js.str("0 0 18 19")),
					attr(badge, "width", js.str("18")),
					attr(badge, "height", js.str("19")),
					attr(badge, "style", cfg("style")),
					attr(badge, "role", js.str("img")),
					js.const_("label", js.op(cfg("labelPrefix"), "+", m(cfg("labels"), id("index")))),
					attr(badge, "aria-label", id("label")),
					js.const_("title", svg("title")),
					js.assign(m(id("title"), "textContent"), id("label")),
					invoke(badge, "appendChild", id("title")),
					js.const_("circle", svg("circle")),
					attr(id("circle"), "cx", js.str("9")),
					attr(id("circle"), "cy", js.str("9")),
					attr(id("circle"), "r", js.str("9")),
					attr(id("circle"), "fill", m(id("art"), "background")),
					invoke(badge, "appendChild", id("circle")),
					js.forOf("d", m(id("art"), "glyph"), [
						js.const_("path", svg("path")),
						attr(id("path"), "d", id("d")),
						attr(id("path"), "fill", cfg("foreground")),
						invoke(badge, "appendChild", id("path")),
					]),
					invoke(node, "insertBefore", badge, m(node, "firstChild")),
					invoke(id("mlSeen"), "set", node, id("index")),
					js.if_(js.and(id("fresh"), js.call(id("mlMotion"), badge)), [
						invoke(badge, "animate", cfg("badgeFrames"), cfg("badgeTiming")),
					]),
					invoke(id("mlArrived"), "add", id("identity")),
				]
			)
		),
	];
}
