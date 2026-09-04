// src/pagescript/builders.ts
/**
 * pagescript builders — "our language" (§5.3). Every builder returns a plain
 * ESTree node from the §5.2 subset; nothing here touches the DOM or a global.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4).
 */

import {
	type Arg,
	type ArrayExpression,
	type ArrowFunctionExpression,
	type AwaitExpression,
	type BinaryExpression,
	type BinaryOperator,
	type BlockStatement,
	type CallExpression,
	type ChainExpression,
	type ConditionalExpression,
	type Expression,
	type ExpressionStatement,
	type ForOfStatement,
	type FunctionExpression,
	type Identifier,
	type IfStatement,
	isBindingName,
	isIdentifierName,
	isParamBindingName,
	isParamName,
	isSpoofName,
	type Literal,
	type LogicalExpression,
	type MemberExpression,
	type NewExpression,
	type ObjectExpression,
	PARAM_PREFIX,
	PagescriptError,
	type Param,
	type Program,
	type Property,
	type ReturnStatement,
	SPOOF_PREFIX,
	type SpreadElement,
	type Statement,
	type TemplateElement,
	type TemplateLiteral,
	type ThrowStatement,
	type TryStatement,
	type UnaryExpression,
	type VariableDeclaration,
	type WhileStatement,
} from "./nodes";

function binding(name: string, what: string): Identifier {
	if (!isBindingName(name)) throw new PagescriptError(`${what}: invalid identifier "${name}"`);
	return { type: "Identifier", name };
}

function block(body: Statement[]): BlockStatement {
	return { type: "BlockStatement", body };
}

/** Property key: bare when it is an identifier name, else a quoted string. */
function key(name: string): Identifier | Literal {
	return isIdentifierName(name) ? { type: "Identifier", name } : { type: "Literal", value: name };
}

/** Object property with an explicit key node (used by `std` for spoofed keys). */
export function property(k: Identifier | Literal, value: Expression): Property {
	return {
		type: "Property",
		key: k,
		value,
		kind: "init",
		computed: false,
		shorthand: false,
		method: false,
	};
}

function accessStep(
	object: Expression,
	step: string | Expression,
	optional: boolean
): MemberExpression {
	if (typeof step === "string") {
		return isIdentifierName(step)
			? { type: "MemberExpression", object, property: key(step), computed: false, optional }
			: { type: "MemberExpression", object, property: key(step), computed: true, optional };
	}
	// A spoofed identifier names a property (`window.<token>`), it is not a variable.
	const computed = !(step.type === "Identifier" && isSpoofName(step.name));
	return { type: "MemberExpression", object, property: step, computed, optional };
}

function escapeRaw(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

export const js = {
	// --- literals & identifiers -------------------------------------------
	id: (name: string): Identifier => {
		if (!isIdentifierName(name)) throw new PagescriptError(`js.id: invalid identifier "${name}"`);
		return { type: "Identifier", name };
	},
	str: (s: string): Literal => ({ type: "Literal", value: s }),
	num: (n: number): Literal => {
		if (!Number.isFinite(n)) throw new RangeError(`js.num: not a finite number: ${n}`);
		return { type: "Literal", value: n };
	},
	bool: (b: boolean): Literal => ({ type: "Literal", value: b }),
	nil: (): Literal => ({ type: "Literal", value: null }),
	undef: (): Identifier => ({ type: "Identifier", name: "undefined" }),
	/** Bind-time parameter slot (typed; substituted by `bind()`). */
	param: <T = unknown>(name: string): Param<T> => {
		if (!isParamBindingName(name)) {
			throw new PagescriptError(`js.param: invalid name "${name}" (identifier without "$")`);
		}
		return { type: "Identifier", name: PARAM_PREFIX + name };
	},
	/** Build-time spoofed global / property name (replaced by `deriveToken`). */
	spoof: (purpose: string): Identifier => {
		if (purpose.length === 0) throw new PagescriptError("js.spoof: empty purpose");
		return { type: "Identifier", name: SPOOF_PREFIX + purpose };
	},
	tpl: (strings: string[], ...exprs: Expression[]): TemplateLiteral => {
		if (strings.length !== exprs.length + 1) {
			throw new RangeError(`js.tpl: need ${exprs.length + 1} strings for ${exprs.length} expressions`);
		}
		const quasis: TemplateElement[] = strings.map((s, i) => ({
			type: "TemplateElement",
			value: { raw: escapeRaw(s), cooked: s },
			tail: i === strings.length - 1,
		}));
		return { type: "TemplateLiteral", quasis, expressions: exprs };
	},
	arr: (...items: Arg[]): ArrayExpression => ({ type: "ArrayExpression", elements: items }),
	obj: (props: Record<string, Expression>): ObjectExpression => ({
		type: "ObjectExpression",
		properties: Object.entries(props).map(([k, v]) => property(key(k), v)),
	}),

	// --- access & calls ----------------------------------------------------
	/** `js.member(js.id("document"), "body", "children", js.num(0))` → `document.body.children[0]` */
	member: (obj: Expression, ...path: (string | Expression)[]): MemberExpression => {
		const [first, ...rest] = path;
		if (first === undefined) throw new RangeError("js.member: path must not be empty");
		let node = accessStep(obj, first, false);
		for (const step of rest) node = accessStep(node, step, false);
		return node;
	},
	call: (callee: Expression, ...args: Arg[]): CallExpression => ({
		type: "CallExpression",
		callee,
		arguments: args,
		optional: false,
	}),
	/** `a?.b?.c` */
	opt: (obj: Expression, ...path: string[]): ChainExpression => {
		const [first, ...rest] = path;
		if (first === undefined) throw new RangeError("js.opt: path must not be empty");
		let node = accessStep(obj, first, true);
		for (const step of rest) node = accessStep(node, step, true);
		return { type: "ChainExpression", expression: node };
	},
	new_: (callee: Expression, ...args: Arg[]): NewExpression => ({
		type: "NewExpression",
		callee,
		arguments: args,
	}),

	// --- statements --------------------------------------------------------
	const_: (name: string, init: Expression): VariableDeclaration => ({
		type: "VariableDeclaration",
		kind: "const",
		declarations: [{ type: "VariableDeclarator", id: binding(name, "js.const_"), init }],
	}),
	let_: (name: string, init?: Expression): VariableDeclaration => ({
		type: "VariableDeclaration",
		kind: "let",
		declarations: [{ type: "VariableDeclarator", id: binding(name, "js.let_"), init: init ?? null }],
	}),
	assign: (target: Expression, value: Expression): ExpressionStatement => {
		const assignable =
			target.type === "MemberExpression" ||
			(target.type === "Identifier" && !isParamName(target.name));
		if (!assignable) {
			throw new PagescriptError(
				`js.assign: target must be an identifier or member, got ${target.type}`
			);
		}
		return {
			type: "ExpressionStatement",
			expression: { type: "AssignmentExpression", operator: "=", left: target, right: value },
		};
	},
	if_: (test: Expression, then: Statement[], else_?: Statement[]): IfStatement => ({
		type: "IfStatement",
		test,
		consequent: block(then),
		alternate: else_ ? block(else_) : null,
	}),
	forOf: (name: string, iterable: Expression, body: Statement[]): ForOfStatement => ({
		type: "ForOfStatement",
		await: false,
		left: {
			type: "VariableDeclaration",
			kind: "const",
			declarations: [{ type: "VariableDeclarator", id: binding(name, "js.forOf"), init: null }],
		},
		right: iterable,
		body: block(body),
	}),
	while_: (test: Expression, body: Statement[]): WhileStatement => ({
		type: "WhileStatement",
		test,
		body: block(body),
	}),
	ret: (value?: Expression): ReturnStatement => ({
		type: "ReturnStatement",
		argument: value ?? null,
	}),
	throw_: (value: Expression): ThrowStatement => ({ type: "ThrowStatement", argument: value }),
	try_: (
		body: Statement[],
		catchParam: string,
		handler: Statement[],
		finalizer?: Statement[]
	): TryStatement => ({
		type: "TryStatement",
		block: block(body),
		handler: { type: "CatchClause", param: binding(catchParam, "js.try_"), body: block(handler) },
		finalizer: finalizer ? block(finalizer) : null,
	}),
	expr: (e: Expression): ExpressionStatement => ({ type: "ExpressionStatement", expression: e }),

	// --- functions ---------------------------------------------------------
	fn: (
		params: string[],
		body: Statement[],
		opts: { async?: boolean; name?: string } = {}
	): FunctionExpression => ({
		type: "FunctionExpression",
		id: opts.name === undefined ? null : binding(opts.name, "js.fn"),
		params: params.map((p) => binding(p, "js.fn")),
		body: block(body),
		async: opts.async === true,
		generator: false,
	}),
	arrow: (
		params: string[],
		bodyOrExpr: Statement[] | Expression,
		opts: { async?: boolean } = {}
	): ArrowFunctionExpression => ({
		type: "ArrowFunctionExpression",
		params: params.map((p) => binding(p, "js.arrow")),
		body: Array.isArray(bodyOrExpr) ? block(bodyOrExpr) : bodyOrExpr,
		expression: !Array.isArray(bodyOrExpr),
		async: opts.async === true,
		generator: false,
	}),
	iife: (body: Statement[], opts: { async?: boolean } = {}): CallExpression => ({
		type: "CallExpression",
		callee: js.arrow([], body, opts),
		arguments: [],
		optional: false,
	}),

	// --- operators ---------------------------------------------------------
	op: (left: Expression, operator: BinaryOperator, right: Expression): BinaryExpression => ({
		type: "BinaryExpression",
		operator,
		left,
		right,
	}),
	not: (e: Expression): UnaryExpression => ({
		type: "UnaryExpression",
		operator: "!",
		prefix: true,
		argument: e,
	}),
	and: (a: Expression, b: Expression): LogicalExpression => ({
		type: "LogicalExpression",
		operator: "&&",
		left: a,
		right: b,
	}),
	or: (a: Expression, b: Expression): LogicalExpression => ({
		type: "LogicalExpression",
		operator: "||",
		left: a,
		right: b,
	}),
	nullish: (a: Expression, b: Expression): LogicalExpression => ({
		type: "LogicalExpression",
		operator: "??",
		left: a,
		right: b,
	}),
	cond: (
		test: Expression,
		consequent: Expression,
		alternate: Expression
	): ConditionalExpression => ({
		type: "ConditionalExpression",
		test,
		consequent,
		alternate,
	}),
	await_: (e: Expression): AwaitExpression => ({ type: "AwaitExpression", argument: e }),
	typeof_: (e: Expression): UnaryExpression => ({
		type: "UnaryExpression",
		operator: "typeof",
		prefix: true,
		argument: e,
	}),
	spread: (e: Expression): SpreadElement => ({ type: "SpreadElement", argument: e }),

	// --- program -----------------------------------------------------------
	program: (body: Statement[]): Program => ({ type: "Program", sourceType: "script", body }),
};
