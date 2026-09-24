// src/page/virtual-cursor/shield.ts
/**
 * The native hit-test shield: a transparent element over the whole viewport, in the top layer
 * where the popover API exists, that intercepts the site's native hover. `curPrepare(q)` opens a
 * two-pixel aperture at the next announced point; `curSeal()` closes it, from the acknowledged
 * `curTo` or from a timeout if the dispatch never lands.
 */

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { POINTER_CONTROL } from "@core/constants/cdp";
import { type Expression, js, type Statement } from "@pagescript";
import { add, joined, text } from "../parts/ast";
import { CURSOR_ART as A, CURSOR } from "./names";

const doc = js.id("document");

/** The shield's closure slots, `curFindShield()` and `curSeal()`. */
export function shieldRoutines(p: { cls: Expression }): Statement[] {
	const shield = js.id("curShield");
	const shieldState = js.let_("curShield", js.nil());
	const shieldFind = js.const_(
		"curFindShield",
		js.arrow([], js.call(js.member(doc, "querySelector"), joined([js.str("."), p.cls, js.str("h")])))
	);
	const shieldTimer = js.let_("curShieldTimer", js.nil());
	const shieldSeal = js.const_(
		CURSOR.seal,
		js.arrow(
			[],
			[
				js.expr(js.call(js.id("clearTimeout"), js.id("curShieldTimer"))),
				js.assign(js.id("curShieldTimer"), js.nil()),
				js.assign(shield, js.call(js.id("curFindShield"))),
				js.if_(shield, [js.assign(js.member(shield, "style", "clipPath"), js.str("none"))]),
			]
		)
	);
	return [shieldState, shieldTimer, shieldFind, shieldSeal];
}

/** `curPrepare(q)`: true when the aperture was opened at `q`. */
export function prepareRoutine(p: { cls: Expression }): Statement {
	const q = js.id("q");
	const shield = js.id("curShield");
	return js.const_(
		CURSOR.prepare,
		js.arrow(
			["q"],
			[
				js.if_(js.or(js.not(q), js.not(js.call(js.id("curFind")))), [js.ret(js.bool(false))]),
				js.if_(
					js.not(
						js.and(
							js.call(js.member(js.id("Number"), "isFinite"), js.member(q, W.x)),
							js.call(js.member(js.id("Number"), "isFinite"), js.member(q, W.y))
						)
					),
					[js.ret(js.bool(false))]
				),
				js.expr(js.call(js.id(CURSOR.seal))),
				js.if_(js.not(shield), [
					js.assign(shield, js.call(js.member(doc, "createElement"), js.str("div"))),
					js.expr(js.call(js.member(shield, "setAttribute"), js.str("class"), add(p.cls, js.str("h")))),
					js.expr(
						js.call(
							js.member(shield, "setAttribute"),
							js.str("style"),
							js.str(
								`position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;pointer-events:auto;cursor:not-allowed;z-index:${A.underlayZIndex};background:transparent;`
							)
						)
					),
					// Under `<html>` like the arrow: where the popover API is missing, the `z-index`
					// fallback must not be trapped in a stacking context either.
					js.expr(js.call(js.member(doc, "documentElement", "appendChild"), shield)),
					js.if_(js.op(js.typeof_(js.member(shield, "showPopover")), "===", js.str("function")), [
						js.expr(js.call(js.member(shield, "setAttribute"), js.str("popover"), js.str("manual"))),
						js.try_([js.expr(js.call(js.member(shield, "showPopover")))], "error", [
							js.expr(js.call(js.member(shield, "removeAttribute"), js.str("popover"))),
						]),
					]),
				]),
				js.const_("x0", js.op(js.member(q, W.x), "-", js.num(A.apertureRadiusPx))),
				js.const_("x1", js.op(js.member(q, W.x), "+", js.num(A.apertureRadiusPx))),
				js.const_("y0", js.op(js.member(q, W.y), "-", js.num(A.apertureRadiusPx))),
				js.const_("y1", js.op(js.member(q, W.y), "+", js.num(A.apertureRadiusPx))),
				js.assign(
					js.member(shield, "style", "clipPath"),
					joined([
						js.str("polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,"),
						text(js.id("x0")),
						js.str("px "),
						text(js.id("y0")),
						js.str("px,"),
						text(js.id("x1")),
						js.str("px "),
						text(js.id("y0")),
						js.str("px,"),
						text(js.id("x1")),
						js.str("px "),
						text(js.id("y1")),
						js.str("px,"),
						text(js.id("x0")),
						js.str("px "),
						text(js.id("y1")),
						js.str("px,"),
						text(js.id("x0")),
						js.str("px "),
						text(js.id("y0")),
						js.str("px)"),
					])
				),
				js.assign(
					js.id("curShieldTimer"),
					js.call(js.id("setTimeout"), js.id(CURSOR.seal), js.num(POINTER_CONTROL.expiresMs))
				),
				js.ret(js.bool(true)),
			]
		)
	);
}
