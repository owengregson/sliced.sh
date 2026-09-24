// scripts/check-css/values.ts — judging one declaration value, token by token.

import { EASING_FUNCTIONS, KEYWORD_POLICY, LITERALS, type PropClass } from "./vocabulary";

const TOKEN_VAR_RE = /^var\(--sl-[a-z0-9-]+\)$/i;
const CALC_FN_RE = /^(calc|min|max|clamp)\((.*)\)$/is;
const FN_RE = /^([a-z-]+)\((.*)\)$/is;
const KEYWORD_RE = /^[a-z][a-z-]*$/i;

/** Split a value on top-level whitespace and commas (parentheses and quotes respected). */
export function splitValue(value: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let cur = "";
	for (const ch of value) {
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === "(") {
			depth++;
			cur += ch;
		} else if (ch === ")") {
			depth--;
			cur += ch;
		} else if (depth === 0 && (ch === " " || ch === "\t" || ch === "\n" || ch === ",")) {
			if (cur) out.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

/** Inside calc(): only tokens, unitless numbers, operators, parens and the allowed literals. */
function calcIsClean(inner: string): boolean {
	const rest = inner
		.replace(/var\(--sl-[a-z0-9-]+\)/gi, " ")
		.replace(/(?<![\w.-])(?:1px|100%)(?![\w%])/g, " ")
		.replace(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w%.])/g, " ")
		.replace(/[()+\-*/\s]/g, "");
	return rest === "";
}

/** Reason a single token is not allowed for the property class, or `null` if it is. */
export function tokenProblem(token: string, cls: PropClass): string | null {
	const lower = token.toLowerCase();
	if (LITERALS.has(lower)) return null;
	if (TOKEN_VAR_RE.test(token)) return null;
	if (/^var\(/i.test(token)) return `non-token custom property "${token}"`;
	const calc = CALC_FN_RE.exec(token);
	if (calc) return calcIsClean(calc[2] ?? "") ? null : `calc() with non-token operand "${token}"`;
	const fn = FN_RE.exec(token);
	if (fn) {
		const name = (fn[1] ?? "").toLowerCase();
		if (name === "url") return null;
		if (/^(?:rgba?|hsla?)$/.test(name)) return `colour literal "${token}"`;
		if (cls === "motion" && EASING_FUNCTIONS.has(name)) return `easing literal "${token}"`;
		for (const arg of splitValue(fn[2] ?? "")) {
			const p = tokenProblem(arg, cls);
			if (p) return p;
		}
		return null;
	}
	if (/^["']/.test(token)) return null;
	if (KEYWORD_RE.test(token)) {
		if (KEYWORD_POLICY[cls](lower)) return null;
		if (cls === "motion") return `generic easing "${token}"`;
		return `keyword "${token}" is not a token`;
	}
	return `raw value "${token}"`;
}
