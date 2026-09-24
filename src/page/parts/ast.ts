// src/page/parts/ast.ts
/**
 * Expression shorthands the page programs share. Each is a one-line composition of the `js`
 * primitives, so a program that uses them emits exactly the nodes it would have spelled out by
 * hand; they exist so the programs read as what they draw rather than as tree plumbing.
 */

import { type Arg, type Expression, js, type Statement } from "@pagescript";

export const id = js.id;
export const n = js.num;
export const s = js.str;

export const add = (a: Expression, b: Expression): Expression => js.op(a, "+", b);
export const sub = (a: Expression, b: Expression): Expression => js.op(a, "-", b);
export const mul = (a: Expression, b: Expression): Expression => js.op(a, "*", b);
export const div = (a: Expression, b: Expression): Expression => js.op(a, "/", b);

/** `object.method(...args)` */
export const callm = (object: Expression, method: string, ...args: Arg[]): Expression =>
	js.call(js.member(object, method), ...args);

/** `object.method(...args);` as a statement. */
export const invoke = (object: Expression, method: string, ...args: Arg[]): Statement =>
	js.expr(callm(object, method, ...args));

/** `name(...args)` for a routine declared in the enclosing closure. */
export const run = (name: string, ...args: Arg[]): Expression => js.call(id(name), ...args);

/** `String(value)` */
export const text = (value: Expression): Expression => js.call(id("String"), value);

/** `target[index]` with a numeric literal or an expression index. */
export const at = (target: Expression, index: number | Expression): Expression =>
	js.member(target, typeof index === "number" ? n(index) : index);

/** `a + b + c…`; an empty list is the empty string rather than a throw. */
export const joined = (parts: Expression[]): Expression => {
	const [first, ...rest] = parts;
	return first === undefined ? s("") : rest.reduce(add, first);
};

/** `promise.then(onFulfilled, onRejected);` */
export const settle = (
	promise: Expression,
	onFulfilled: Statement[],
	onRejected: Statement[]
): Statement =>
	js.expr(callm(promise, "then", js.arrow([], onFulfilled), js.arrow([], onRejected)));
