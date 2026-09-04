// src/pagescript/emit.ts
/**
 * Emitter (§5.4): resolves `$$spoof:*` identifiers to `deriveToken(seed, purpose)`,
 * validates that every `$$param:*` identifier is declared by the program,
 * rewrites each parameter slot to the quoted placeholder literal
 * `"$$param:<name>"` (which `bind()` later replaces, quotes included) and
 * prints the tree with `astring` in compact form.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4); `astring` never reaches a shipped bundle.
 */

import { generate } from "astring";
import type { PageProgram, ParamMap, ParamSlots } from "./bind";
import { js } from "./builders";
import {
	isParamName,
	isSpoofName,
	PARAM_PREFIX,
	PagescriptError,
	type ParamSpec,
	paramNameOf,
	spoofPurposeOf,
} from "./nodes";
import { deriveToken } from "./spoof";

export interface EmitOptions {
	seed: string;
}

export interface Emitted {
	code: string;
	params: ParamSpec[];
}

type AnyNode = { type: string; [key: string]: unknown };

function isNode(v: unknown): v is AnyNode {
	return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/** Positions in which an identifier is a *name*, not a reference or a value. */
function isNamePosition(parent: AnyNode | undefined, keyName: string | undefined): boolean {
	if (!parent) return false;
	if (parent.type === "MemberExpression" && keyName === "property" && parent.computed === false)
		return true;
	if (parent.type === "Property" && keyName === "key" && parent.computed === false) return true;
	return false;
}

interface Ctx {
	seed: string;
	declared: ReadonlySet<string>;
	program: string;
}

function transform(
	value: unknown,
	ctx: Ctx,
	parent: AnyNode | undefined,
	keyName: string | undefined
): unknown {
	if (Array.isArray(value)) return value.map((v) => transform(v, ctx, parent, keyName));
	if (!isNode(value)) return value;

	if (value.type === "Identifier" && typeof value.name === "string") {
		const name = value.name;
		if (isSpoofName(name)) {
			return { type: "Identifier", name: deriveToken(ctx.seed, spoofPurposeOf(name)) };
		}
		if (isParamName(name)) {
			const param = paramNameOf(name);
			if (!ctx.declared.has(param)) {
				throw new PagescriptError(
					`program "${ctx.program}": parameter "${param}" is used but not declared`
				);
			}
			if (isNamePosition(parent, keyName)) {
				throw new PagescriptError(
					`program "${ctx.program}": parameter "${param}" cannot be used as a property name`
				);
			}
			return { type: "Literal", value: PARAM_PREFIX + param };
		}
		return { type: "Identifier", name };
	}

	if (
		value.type === "Literal" &&
		typeof value.value === "string" &&
		value.value.includes(PARAM_PREFIX)
	) {
		throw new PagescriptError(
			`program "${ctx.program}": string literal ${JSON.stringify(value.value)} collides with the parameter placeholder syntax`
		);
	}

	const out: AnyNode = { type: value.type };
	for (const [k, v] of Object.entries(value)) {
		if (k === "type") continue;
		out[k] = transform(v, ctx, value, k);
	}
	return out;
}

/**
 * Build-time: compile a program to a compact JS string with spoofed
 * identifiers resolved and parameter slots left as quoted placeholders.
 */
export function emit<P extends ParamMap>(program: PageProgram<P>, options: EmitOptions): Emitted {
	const params: ParamSpec[] = Object.entries(program.params).map(([name, type]) => ({
		name,
		type,
	}));
	const slots: Record<string, unknown> = {};
	for (const p of params) slots[p.name] = js.param(p.name);
	const tree = program.build(slots as ParamSlots<P>);
	const resolved = transform(
		tree,
		{ seed: options.seed, declared: new Set(params.map((p) => p.name)), program: program.name },
		undefined,
		undefined
	) as { type: string };
	const code = generate(resolved, { indent: "", lineEnd: "" });
	return { code, params };
}
