/** MAIN-world move-log artwork. All host selectors, labels and colors are bound at build time. */
import { type Expression, js, type Statement } from "@pagescript";
import { nodeRoutines } from "./move-list-ratings/node";
import { paintRoutines } from "./move-list-ratings/paint";
import { callm as call, id, invoke } from "./parts/ast";
import { canAnimate } from "./parts/motion";

const m = js.member;

export function moveListStatements(
	config: Expression,
	cls: Expression,
	icons: Expression
): Statement[] {
	const cfg = (key: string) => m(config, key);
	const node = id("node");
	const row = id("row");
	const badge = id("badge");
	const doc = id("document");
	const observe = invoke(
		id("mlObserver"),
		"observe",
		m(doc, "body"),
		js.obj({
			childList: js.bool(true),
			subtree: js.bool(true),
			characterData: js.bool(true),
			attributes: js.bool(true),
			attributeFilter: js.arr(cfg("nodeAttr"), js.str("style"), js.str("class")),
		})
	);
	return [
		js.let_("mlRows", js.new_(id("Map"))),
		js.const_("mlSeen", js.new_(id("WeakMap"))),
		js.const_("mlPainted", js.new_(id("Map"))),
		js.const_("mlArrived", js.new_(id("Set"))),
		js.const_("mlMotion", js.arrow(["el"], canAnimate(id("el"), cfg("reducedMotion")))),
		...paintRoutines(cfg),
		js.let_("mlTimer", js.nil()),
		...nodeRoutines(cfg, cls, icons),
		js.const_(
			"mlRender",
			js.arrow(
				[],
				[
					js.if_(js.not(m(id("mlRows"), "size")), [
						invoke(id("mlObserver"), "disconnect"),
						invoke(id("mlArrived"), "clear"),
						js.forOf("text", call(id("mlPainted"), "keys"), [
							js.expr(js.call(id("mlRestore"), id("text"))),
						]),
						js.forOf("badge", call(doc, "querySelectorAll", js.op(js.str("."), "+", cls)), [
							invoke(badge, "remove"),
						]),
						js.ret(),
					]),
					js.forOf("badge", call(doc, "querySelectorAll", js.op(js.str("."), "+", cls)), [
						js.const_("parent", m(badge, "parentElement")),
						js.if_(js.and(id("parent"), js.not(call(id("parent"), "matches", cfg("nodes")))), [
							invoke(badge, "remove"),
						]),
					]),
					js.forOf("list", call(doc, "querySelectorAll", cfg("hosts")), [
						js.forOf("node", call(id("list"), "querySelectorAll", cfg("nodes")), [
							js.expr(js.call(id("mlNode"), node)),
						]),
					]),
					js.forOf("text", call(id("mlPainted"), "keys"), [
						js.if_(
							js.or(
								js.not(m(id("text"), "isConnected")),
								js.not(call(m(id("text"), "parentElement"), "querySelector", js.op(js.str("."), "+", cls)))
							),
							[js.expr(js.call(id("mlRestore"), id("text")))]
						),
					]),
					// Drain our own inserts; keep the observer attached through host rerenders.
					invoke(id("mlObserver"), "takeRecords"),
					observe,
				]
			)
		),
		js.const_(
			"mlObserver",
			js.new_(
				id("MutationObserver"),
				js.arrow(
					[],
					[
						js.if_(js.op(id("mlTimer"), "!==", js.nil()), [js.ret()]),
						js.assign(
							id("mlTimer"),
							call(
								id("window"),
								"setTimeout",
								js.arrow([], [js.assign(id("mlTimer"), js.nil()), js.expr(js.call(id("mlRender")))]),
								js.num(0)
							)
						),
					]
				)
			)
		),
		js.const_(
			"mlUpdate",
			js.arrow(
				["rows"],
				[
					js.assign(id("mlRows"), js.new_(id("Map"))),
					js.forOf("row", js.or(id("rows"), js.arr()), [
						invoke(id("mlRows"), "set", m(row, js.num(0)), row),
					]),
					js.expr(js.call(id("mlRender"))),
				]
			)
		),
	];
}
