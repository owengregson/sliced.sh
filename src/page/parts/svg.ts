// src/page/parts/svg.ts
/** SVG element plumbing: every page layer draws with these two calls. */

import { type Expression, js, type Statement } from "@pagescript";
import { callm, id, s } from "./ast";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** `document.createElementNS(SVG_NS, tag)` */
export const svgEl = (tag: string): Expression =>
	callm(id("document"), "createElementNS", s(SVG_NS), s(tag));

/** `el.setAttribute(name, value);` */
export const setAttr = (el: Expression, name: string, value: Expression): Statement =>
	js.expr(callm(el, "setAttribute", s(name), value));
