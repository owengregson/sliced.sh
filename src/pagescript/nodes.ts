// src/pagescript/nodes.ts
/**
 * pagescript node set (§5.2): a strict subset of ESTree — no classes, no
 * generators, no `with`, no labels. Every node carries an ESTree `type` so
 * `astring.generate()` prints it unchanged; the interfaces are reused from
 * `@types/estree` rather than redeclared.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4). Page programs ship as generated strings; the
 * only runtime-safe pieces are `src/core/spoof.ts` and `SPOOF_PURPOSES`.
 *
 * Placeholders are plain Identifiers with a reserved name prefix:
 *   `$$param:<name>`   — a bind-time parameter, substituted by `bind()`
 *   `$$spoof:<purpose>` — a build-time spoofed identifier (`deriveToken`)
 */

import type {
	ArrayExpression,
	ArrowFunctionExpression,
	AssignmentExpression,
	AwaitExpression,
	BinaryExpression,
	BinaryOperator,
	BlockStatement,
	CallExpression,
	CatchClause,
	ChainExpression,
	ConditionalExpression,
	ExpressionStatement,
	ForOfStatement,
	FunctionExpression,
	Identifier,
	IfStatement,
	LogicalExpression,
	LogicalOperator,
	MemberExpression,
	NewExpression,
	ObjectExpression,
	Program,
	Property,
	ReturnStatement,
	SimpleLiteral,
	SpreadElement,
	TemplateElement,
	TemplateLiteral,
	ThrowStatement,
	TryStatement,
	UnaryExpression,
	VariableDeclaration,
	VariableDeclarator,
	WhileStatement,
} from "estree";

export type {
	ArrayExpression,
	ArrowFunctionExpression,
	AssignmentExpression,
	AwaitExpression,
	BinaryExpression,
	BinaryOperator,
	BlockStatement,
	CallExpression,
	CatchClause,
	ChainExpression,
	ConditionalExpression,
	ExpressionStatement,
	ForOfStatement,
	FunctionExpression,
	Identifier,
	IfStatement,
	LogicalExpression,
	LogicalOperator,
	MemberExpression,
	NewExpression,
	ObjectExpression,
	Program,
	Property,
	ReturnStatement,
	SpreadElement,
	TemplateElement,
	TemplateLiteral,
	ThrowStatement,
	TryStatement,
	UnaryExpression,
	VariableDeclaration,
	VariableDeclarator,
	WhileStatement,
};

/** Only simple literals (string / number / boolean / null) — no regex, no bigint. */
export type Literal = SimpleLiteral;

export const PARAM_PREFIX = "$$param:";
export const SPOOF_PREFIX = "$$spoof:";

/** Bind-time parameter types (§5.4). */
export type ParamType = "string" | "number" | "boolean" | "json";

/** Anything `JSON.stringify` round-trips, for `json` parameters. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type ParamValue<T extends ParamType> = T extends "string"
	? string
	: T extends "number"
		? number
		: T extends "boolean"
			? boolean
			: JsonValue;

/**
 * A bind-parameter placeholder. Structurally an Identifier named
 * `$$param:<name>`; the phantom `__value` carries the parameter's TypeScript
 * type so `build(p)` gets typed slots.
 */
export interface Param<T = unknown> extends Identifier {
	readonly __value?: T;
}

export interface ParamSpec {
	name: string;
	type: ParamType;
}

export type Expression =
	| Identifier
	| Literal
	| TemplateLiteral
	| ArrayExpression
	| ObjectExpression
	| MemberExpression
	| CallExpression
	| NewExpression
	| UnaryExpression
	| BinaryExpression
	| LogicalExpression
	| ConditionalExpression
	| AssignmentExpression
	| AwaitExpression
	| ChainExpression
	| FunctionExpression
	| ArrowFunctionExpression
	| Param;

/** What may appear in argument / array-element position. */
export type Arg = Expression | SpreadElement;

export type Statement =
	| BlockStatement
	| ExpressionStatement
	| VariableDeclaration
	| ReturnStatement
	| IfStatement
	| ForOfStatement
	| WhileStatement
	| TryStatement
	| ThrowStatement;

export type Node =
	| Program
	| FunctionExpression
	| ArrowFunctionExpression
	| BlockStatement
	| ExpressionStatement
	| VariableDeclaration
	| ReturnStatement
	| IfStatement
	| ForOfStatement
	| WhileStatement
	| TryStatement
	| ThrowStatement
	| Identifier
	| Literal
	| TemplateLiteral
	| ArrayExpression
	| ObjectExpression
	| Property
	| MemberExpression
	| CallExpression
	| NewExpression
	| UnaryExpression
	| BinaryExpression
	| LogicalExpression
	| ConditionalExpression
	| AssignmentExpression
	| AwaitExpression
	| SpreadElement
	| ChainExpression
	| Param;

/**
 * Structural children required by ESTree for nodes in the set above
 * (declarators, catch clauses, template quasis). They are never built
 * directly; the builders create them as parts of their parents.
 */
export type StructuralNode = VariableDeclarator | CatchClause | TemplateElement;

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);

/** True when `name` can be printed bare as a binding or property name. */
export function isIdentifierName(name: string): boolean {
	return IDENT_RE.test(name);
}

/** True when `name` can be declared as a variable or parameter. */
export function isBindingName(name: string): boolean {
	return isIdentifierName(name) && !RESERVED.has(name);
}

export function isParamName(name: string): boolean {
	return name.startsWith(PARAM_PREFIX);
}

export function isSpoofName(name: string): boolean {
	return name.startsWith(SPOOF_PREFIX);
}

export function paramNameOf(identifier: string): string {
	return identifier.slice(PARAM_PREFIX.length);
}

export function spoofPurposeOf(identifier: string): string {
	return identifier.slice(SPOOF_PREFIX.length);
}

export class PagescriptError extends Error {
	override name = "PagescriptError";
}
