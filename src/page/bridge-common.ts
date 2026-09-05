// src/page/bridge-common.ts
/**
 * Builder helpers shared by the MAIN-world page programs (§5.5, §13.3).
 * Everything here returns pagescript nodes (`js` / `std` only, C2) — nothing
 * executes at build time and nothing is imported by a runtime bundle.
 *
 * Wire protocol (§13.3 rule 5): every envelope is
 * `{ [spoofedKey]: token, k: kind, i?: id, p?: payload }` with the field
 * letters from `BRIDGE_WIRE` and the kinds from `BRIDGE_KINDS`. Bridge state
 * lives in closures (no `window` properties, rule 3).
 */

import { BRIDGE_KINDS } from "@content/adapters/adapter";
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { type Expression, js, type Statement, std } from "@pagescript";

export const KINDS = BRIDGE_KINDS;

const win = js.id("window");

export const NAMES = {
	post: "post",
	cursor: "cur",
	safe: "safe",
} as const;

/** `js.obj` with wire-letter keys: `{ k: kind, i: id, p: payload }`. */
export function envelope(kind: Expression, id: Expression, payload: Expression): Expression {
	return js.obj({ [W.kind]: kind, [W.id]: id, [W.payload]: payload });
}

/** `const post = (k, i, p) => window.postMessage({ [key]: token, k, i, p }, location.origin);` */
export function definePost(token: Expression): Statement {
	return js.const_(
		NAMES.post,
		js.arrow(
			["k", "i", "p"],
			std.postToExtension(token, envelope(js.id("k"), js.id("i"), js.id("p")))
		)
	);
}

/** `post(kind, id, payload)` as a statement. */
export function post(kind: string, id: Expression, payload: Expression): Statement {
	return postExpr(js.str(kind), id, payload);
}

/** `post(<kind expression>, id, payload)` as a statement. */
export function postExpr(kind: Expression, id: Expression, payload: Expression): Statement {
	return js.expr(js.call(js.id(NAMES.post), kind, id, payload));
}

/** `const safe = fn => { try { return fn(); } catch (err) { return null; } };` */
export function defineSafe(): Statement {
	return js.const_(
		NAMES.safe,
		js.arrow(["fn"], [js.try_([js.ret(js.call(js.id("fn")))], "err", [js.ret(js.nil())])])
	);
}

/** `safe(() => expr)` */
export function safe(expr: Expression): Expression {
	return js.call(js.id(NAMES.safe), js.arrow([], expr));
}

const listenerOptions = (): Expression =>
	js.obj({ capture: js.bool(true), passive: js.bool(true) });

/** `let cur = null;` — the closure slot for the last trusted pointer position. */
export function cursorState(): Statement {
	return js.let_(NAMES.cursor, js.nil());
}

/**
 * Capture-phase, passive `pointermove` / `pointerdown` / `pointerup` listeners
 * on `window` that remember the last *trusted* pointer position as
 * `{ x, y, t }` (wire letters) in `cur`. Installed once, inside the program's
 * closure, and only once the program has decided it is on its site.
 */
export function cursorListeners(): Statement[] {
	const ev = js.id("ev");
	const handler = js.arrow(
		["ev"],
		[
			js.if_(js.not(js.member(ev, "isTrusted")), [js.ret()]),
			js.assign(
				js.id(NAMES.cursor),
				js.obj({
					[W.x]: js.member(ev, "clientX"),
					[W.y]: js.member(ev, "clientY"),
					[W.at]: js.call(js.member(js.id("Date"), "now")),
				})
			),
		]
	);
	return [
		js.const_("onPointer", handler),
		...["pointermove", "pointerdown", "pointerup"].map((type) =>
			js.expr(
				js.call(js.member(win, "addEventListener"), js.str(type), js.id("onPointer"), listenerOptions())
			)
		),
	];
}

export interface DispatchCase {
	kind: string;
	body: Statement[];
}

/**
 * `const handle = d => { const k = d.k, i = d.i, q = d.p; if (k === …) {…; return;} … }`
 * — the command handler a program registers with `std.onExtensionMessage`.
 * `before` runs ahead of the kind chain (e.g. re-locating the board).
 */
export function defineHandle(cases: DispatchCase[], before: Statement[] = []): Statement {
	const d = js.id("d");
	const chain: Statement[] = cases.map((c) =>
		js.if_(js.op(js.id("k"), "===", js.str(c.kind)), [...c.body, js.ret()])
	);
	return js.const_(
		"handle",
		js.arrow(
			["d"],
			[
				js.const_("k", js.member(d, W.kind)),
				js.const_("i", js.member(d, W.id)),
				js.const_("q", js.member(d, W.payload)),
				...before,
				...chain,
			]
		)
	);
}

/** `window.addEventListener("message", …)` filtered to the peer token, routed to `handle`. */
export function listen(peer: Expression): Statement {
	return js.expr(std.onExtensionMessage(peer, js.id("handle")));
}

/** `(expr || [])` */
export function orEmpty(expr: Expression): Expression {
	return js.or(expr, js.arr());
}

/** `Math.min(a, b)` */
export function min(a: Expression, b: Expression): Expression {
	return js.call(js.member(js.id("Math"), "min"), a, b);
}

/** `setTimeout(fn, ms)` */
export function setTimeout_(fn: Expression, ms: Expression): Statement {
	return js.expr(js.call(js.id("setTimeout"), fn, ms));
}
