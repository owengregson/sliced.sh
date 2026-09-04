// scripts/check-css.ts — C3 lint: numeric and colour CSS values must be Lattice tokens (§10.1).
//
// For the listed properties every value token must be `var(--sl-…)`, a `calc()`/`min()`/`max()`/
// `clamp()` of tokens, `0`, `1px`, `100%`, `auto`, `inherit`, `currentColor`, `transparent`,
// `none`, or a keyword (e.g. `solid`, a transition property name, a forced-colors system colour).
// Independently of the property list, a hex colour or `rgb()/rgba()/hsl()/hsla()` literal anywhere
// outside `css/tokens.css` is a violation (Appendix F §2.1: no hex outside the palette).
// `css/tokens.css` is generated from the token source and is skipped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface CssViolation {
	file: string;
	line: number;
	property: string;
	value: string;
	reason: string;
}

const GENERATED = new Set(["css/tokens.css"]);

/** Properties whose every value token must be a token or an allowed literal (§10.1 list). */
const CHECKED_PROPERTY_RE =
	/^(?:color|background(?:-color)?|border-color|box-shadow|padding(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|margin(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|font-size|border-radius|border-(?:top|bottom)-(?:left|right)-radius|border-(?:start|end)-(?:start|end)-radius|transition|transition-duration|transition-delay|z-index)$/;

/** Bare tokens accepted in a checked property, case-insensitive. */
const LITERALS = new Set([
	"0",
	"1px",
	"100%",
	"auto",
	"inherit",
	"currentcolor",
	"transparent",
	"none",
	"initial",
	"unset",
	"revert",
	"!important",
	"/",
]);

const TOKEN_VAR_RE = /^var\(--sl-[a-z0-9-]+\)$/i;
const CALC_FN_RE = /^(calc|min|max|clamp)\((.*)\)$/is;
const FN_RE = /^([a-z-]+)\((.*)\)$/is;
const KEYWORD_RE = /^[a-z][a-z-]*$/i;
const COLOR_LITERAL_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

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

/** Reason a single token is not allowed, or `null` if it is. */
function tokenProblem(token: string): string | null {
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
		for (const arg of splitValue(fn[2] ?? "")) {
			const p = tokenProblem(arg);
			if (p) return p;
		}
		return null;
	}
	if (/^["']/.test(token)) return null;
	if (KEYWORD_RE.test(token)) return null;
	return `raw value "${token}"`;
}

function stripComments(css: string): string {
	// Keep newlines so line numbers survive.
	return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function lineAt(src: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++;
	return n;
}

const DECL_RE = /(?<![\w-])([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g;

/** Pure check over `{ "css/file.css": source }` — used by tests and by `checkCss()`. */
export function findCssViolations(files: Record<string, string>): CssViolation[] {
	const out: CssViolation[] = [];
	for (const [file, raw] of Object.entries(files)) {
		if (GENERATED.has(file)) continue;
		const src = stripComments(raw);
		for (const m of src.matchAll(DECL_RE)) {
			const property = (m[1] ?? "").toLowerCase();
			const value = (m[2] ?? "").trim();
			if (property === "" || value === "") continue;
			const push = (reason: string): void => {
				out.push({ file, line: lineAt(src, m.index ?? 0), property, value, reason });
			};
			if (CHECKED_PROPERTY_RE.test(property)) {
				for (const token of splitValue(value)) {
					const p = tokenProblem(token);
					if (p) {
						push(p);
						break;
					}
				}
			} else if (COLOR_LITERAL_RE.test(value)) push("colour literal outside the palette");
		}
	}
	return out;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");

function walk(dir: string, acc: Record<string, string>): void {
	for (const e of readdirSync(dir).sort()) {
		const p = path.join(dir, e);
		if (statSync(p).isDirectory()) walk(p, acc);
		else if (p.endsWith(".css"))
			acc[path.relative(REPO_ROOT, p).split(path.sep).join("/")] = readFileSync(p, "utf8");
	}
}

export function checkCss(root = "css"): void {
	const files: Record<string, string> = {};
	walk(path.resolve(REPO_ROOT, root), files);
	const violations = findCssViolations(files);
	if (violations.length) {
		for (const v of violations)
			console.error(`${v.file}:${v.line}: ${v.property}: ${v.value} — ${v.reason}`);
		throw new Error(`${violations.length} CSS token violation(s)`);
	}
}

if (import.meta.main) {
	checkCss();
	console.log("check-css: ok");
}
