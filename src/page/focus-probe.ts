// src/page/focus-probe.ts
/**
 * `focus-probe` (§5.5): the executor's pre-flight, evaluated through CDP
 * `Runtime.evaluate` (`returnByValue: true`). A single IIFE expression (no
 * top-level `return`) returning
 * `{ hasFocus, visibility, boardRect, dpr, scrollX, scrollY }` where
 * `boardRect` is the plain `{ x, y, width, height }` of the first element
 * the bound selector ladder matches (or `null`).
 */

import { defineProgram, js, std } from "@pagescript";

const doc = js.id("document");
const win = js.id("window");
const el = js.id("el");

export const focusProbe = defineProgram({
	name: "focus-probe",
	params: { boardSelectors: "json" },
	build: (p) =>
		js.program([
			js.expr(
				js.iife([
					js.const_(
						"out",
						js.arrow(
							["el"],
							js.obj({
								hasFocus: js.call(js.member(doc, "hasFocus")),
								visibility: js.member(doc, "visibilityState"),
								boardRect: js.cond(el, std.rect(el), js.nil()),
								dpr: js.or(js.member(win, "devicePixelRatio"), js.num(1)),
								scrollX: js.or(js.member(win, "scrollX"), js.num(0)),
								scrollY: js.or(js.member(win, "scrollY"), js.num(0)),
							})
						)
					),
					js.forOf("s", p.boardSelectors, [
						js.const_("el", std.query(js.id("s"))),
						js.if_(el, [js.ret(js.call(js.id("out"), el))]),
					]),
					js.ret(js.call(js.id("out"), js.nil())),
				])
			),
		]),
});
