// src/page/parts/motion.ts
/** The page's reduced-motion preference, read the one way every layer reads it. */

import { type Expression, js } from "@pagescript";
import { callm, id, s } from "./ast";

/** `window.matchMedia && window.matchMedia(query).matches` */
export function prefersReducedMotion(query: Expression): Expression {
	const win = id("window");
	return js.and(js.member(win, "matchMedia"), js.member(callm(win, "matchMedia", query), "matches"));
}

/** `typeof el.animate === "function" && !(<reduced motion>)` */
export function canAnimate(el: Expression, query: Expression): Expression {
	return js.and(
		js.op(js.typeof_(js.member(el, "animate")), "===", s("function")),
		js.not(prefersReducedMotion(query))
	);
}
