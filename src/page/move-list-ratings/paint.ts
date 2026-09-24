// src/page/move-list-ratings/paint.ts
/**
 * The move text's tint: `mlPaint(text, fill, motion)` recolours a move to its verdict's colour
 * (animating from the site's own colour), remembering the inline colour, its priority and the
 * site's offset class so that `mlRestore(text)` can put every one of them back exactly.
 */

import { type Expression, js, type Statement } from "@pagescript";
import { callm as call, id, invoke } from "../parts/ast";

const m = js.member;

/** `mlRestore` and `mlPaint`, in that order. */
export function paintRoutines(cfg: (key: string) => Expression): Statement[] {
	return [
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
	];
}
