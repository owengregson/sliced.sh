// src/pagescript/std.ts
/**
 * Domain combinators (§5.3) built from the `js` primitives so page programs
 * stay short and uniform. Everything here prints to page-realm JS; nothing
 * executes at build time.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4); only `@core/spoof` and the `SPOOF_PURPOSES`
 * registry are shared with runtime code. The registry is imported by file,
 * not via the `@core/constants` barrel: the barrel pulls in `limits.ts`,
 * which reads a bundler define at load time and so cannot run inside the
 * plain-bun build process that hosts the generator.
 */

import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { js, property } from "./builders";
import type { CallExpression, Expression, Statement } from "./nodes";

/**
 * Both message directions (`postToExtension`, `onExtensionMessage`) tag the
 * envelope with `deriveToken(seed, SPOOF_PURPOSES.messageKey)`; the
 * ISOLATED-world side derives the same key via `@core/spoof` — never a literal.
 */
const MESSAGE_KEY = SPOOF_PURPOSES.messageKey;

const doc = js.id("document");
const win = js.id("window");

export const std = {
	/** `document.querySelector(selector)` */
	query: (selector: Expression): CallExpression =>
		js.call(js.member(doc, "querySelector"), selector),

	/** `Array.from(document.querySelectorAll(selector))` — a plain array, not a NodeList. */
	queryAll: (selector: Expression): CallExpression =>
		js.call(js.member(js.id("Array"), "from"), js.call(js.member(doc, "querySelectorAll"), selector)),

	/** `window.postMessage({ [spoofedKey]: token, ...payload }, location.origin)` */
	postToExtension: (token: Expression, payload: Expression): CallExpression =>
		js.call(
			js.member(win, "postMessage"),
			{
				type: "ObjectExpression",
				properties: [property(js.spoof(MESSAGE_KEY), token), js.spread(payload)],
			},
			js.member(js.id("location"), "origin")
		),

	/**
	 * `window.addEventListener("message", ev => …)` that invokes `handler(data)`
	 * only for same-window, same-origin messages whose spoofed key equals
	 * `token` (§13: no untrusted input reaches the handler).
	 */
	onExtensionMessage: (token: Expression, handler: Expression): CallExpression => {
		const ev = js.id("ev");
		const data = js.id("d");
		return js.call(
			js.member(win, "addEventListener"),
			js.str("message"),
			js.arrow(
				["ev"],
				[
					js.if_(js.op(js.member(ev, "source"), "!==", win), [js.ret()]),
					js.if_(js.op(js.member(ev, "origin"), "!==", js.member(js.id("location"), "origin")), [
						js.ret(),
					]),
					js.const_("d", js.member(ev, "data")),
					js.if_(
						js.or(
							js.not(data),
							js.or(
								js.op(js.typeof_(data), "!==", js.str("object")),
								js.op(js.member(data, js.spoof(MESSAGE_KEY)), "!==", token)
							)
						),
						[js.ret()]
					),
					js.expr(js.call(handler, data)),
				]
			)
		);
	},

	/**
	 * Idempotent install guard: `if (typeof window.<spoofed> === "undefined") window.<spoofed> = value;`
	 *
	 * Kept for completeness of the §5.3 surface. Per the telemetry contract
	 * (§13.3: no DOM/global signatures) no shipped page program installs
	 * window properties, so no shipped program uses this combinator.
	 */
	defineOnce: (globalName: string, value: Expression): Statement => {
		const slot = js.member(win, js.spoof(globalName));
		return js.if_(js.op(js.typeof_(slot), "===", js.str("undefined")), [js.assign(slot, value)]);
	},

	/**
	 * `try { body } catch (err) { … }`. The page realm must not touch
	 * `console` (§13), so the default handler swallows; pass `onError` to
	 * route the error (e.g. via `postToExtension`).
	 */
	tryCatchLog: (body: Statement[], onError?: (err: Expression) => Statement[]): Statement =>
		js.try_(body, "err", onError ? onError(js.id("err")) : []),

	/** `getBoundingClientRect()` copied to a plain `{x, y, width, height}` object. */
	rect: (el: Expression): CallExpression => {
		const r = js.id("r");
		return js.call(
			js.arrow(
				["r"],
				js.obj({
					x: js.member(r, "x"),
					y: js.member(r, "y"),
					width: js.member(r, "width"),
					height: js.member(r, "height"),
				})
			),
			js.call(js.member(el, "getBoundingClientRect"))
		);
	},

	/** `JSON.parse(JSON.stringify(e))` */
	jsonClone: (e: Expression): CallExpression =>
		js.call(js.member(js.id("JSON"), "parse"), js.call(js.member(js.id("JSON"), "stringify"), e)),
};
