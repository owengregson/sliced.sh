/** MAIN-world move-log artwork. All host selectors, labels and colors are bound at build time. */
import { type Expression, js, type Statement } from "@pagescript";

const id = js.id;
const m = js.member;
const call = (object: Expression, method: string, ...args: Expression[]) =>
	js.call(m(object, method), ...args);
const invoke = (object: Expression, method: string, ...args: Expression[]) =>
	js.expr(call(object, method, ...args));

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
	const svg = (tag: string) =>
		call(doc, "createElementNS", js.str("http://www.w3.org/2000/svg"), js.str(tag));
	const attr = (el: Expression, name: string, value: Expression) =>
		invoke(el, "setAttribute", js.str(name), value);
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
		js.const_(
			"mlMotion",
			js.arrow(
				["el"],
				js.and(
					js.op(js.typeof_(m(id("el"), "animate")), "===", js.str("function")),
					js.not(
						js.and(
							m(id("window"), "matchMedia"),
							m(call(id("window"), "matchMedia", cfg("reducedMotion")), "matches")
						)
					)
				)
			)
		),
		js.const_(
			"mlRestore",
			js.arrow(
				["text"],
				[
					js.const_("saved", call(id("mlPainted"), "get", id("text"))),
					js.if_(js.not(id("saved")), [js.ret()]),
					js.if_(m(id("saved"), "animation"), [invoke(m(id("saved"), "animation"), "cancel")]),
					js.if_(
						js.op(
							call(m(id("text"), "style"), "getPropertyValue", js.str("color")),
							"===",
							m(id("saved"), "applied")
						),
						[
							invoke(
								m(id("text"), "style"),
								"setProperty",
								js.str("color"),
								m(id("saved"), "color"),
								m(id("saved"), "priority")
							),
						]
					),
					js.if_(m(id("saved"), "offset"), [
						invoke(m(id("text"), "classList"), "add", cfg("offsetClass")),
					]),
					invoke(id("mlPainted"), "delete", id("text")),
				]
			)
		),
		js.const_(
			"mlPaint",
			js.arrow(
				["text", "fill", "motion"],
				[
					js.const_(
						"from",
						js.cond(
							id("motion"),
							m(call(id("window"), "getComputedStyle", id("text")), "color"),
							js.str("")
						)
					),
					js.let_("saved", call(id("mlPainted"), "get", id("text"))),
					js.if_(js.not(id("saved")), [
						js.assign(
							id("saved"),
							js.obj({
								color: call(m(id("text"), "style"), "getPropertyValue", js.str("color")),
								priority: call(m(id("text"), "style"), "getPropertyPriority", js.str("color")),
								offset: call(m(id("text"), "classList"), "contains", cfg("offsetClass")),
							})
						),
						invoke(id("mlPainted"), "set", id("text"), id("saved")),
					]),
					invoke(m(id("text"), "style"), "setProperty", js.str("color"), id("fill"), js.str("")),
					js.assign(
						m(id("saved"), "applied"),
						call(m(id("text"), "style"), "getPropertyValue", js.str("color"))
					),
					invoke(m(id("text"), "classList"), "remove", cfg("offsetClass")),
					js.if_(id("motion"), [
						js.if_(m(id("saved"), "animation"), [invoke(m(id("saved"), "animation"), "cancel")]),
						js.assign(
							m(id("saved"), "animation"),
							call(
								id("text"),
								"animate",
								js.arr(js.obj({ color: id("from") }), js.obj({ color: id("fill") })),
								cfg("textTiming")
							)
						),
					]),
				]
			)
		),
		js.let_("mlTimer", js.nil()),
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
