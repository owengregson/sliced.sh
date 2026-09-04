// scripts/check-css.ts — C3 lint: numeric and colour CSS values must be Lattice tokens (§10.1).
//
// For the listed properties every value token must be `var(--sl-…)`, a `calc()`/`min()`/`max()`/
// `clamp()` of tokens, `0`, `1px`, `100%`, `auto`, `inherit`, `currentColor`, `transparent`,
// `none`, or a keyword allowed for the property class (border styles, background keywords,
// `inset`, transition property / animation names, the CSS system colours for forced-colors).
// CSS named colours (`red`, `white`, …) and generic easings (`ease`, `linear`, `steps()`,
// `cubic-bezier()`) are rejected; border/outline widths accept only `0`, `1px` or a token.
// Custom-property declarations (`--*`) outside `css/tokens.css` are checked too, so no second
// token source can be introduced by hand (C3). Independently of the property list, a hex colour
// or `rgb()/rgba()/hsl()/hsla()` literal anywhere outside `css/tokens.css` is a violation
// (Appendix F §2.1: no hex outside the palette). `css/tokens.css` is generated and skipped.
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

/**
 * Property classes. Each checked property accepts tokens/allowed literals plus a class-specific
 * keyword set; everything else (raw numbers, named colours, generic easings, `thin`, …) fails.
 */
type PropClass = "color" | "background" | "shadow" | "border" | "motion" | "numeric" | "custom";

const CLASS_RES: ReadonlyArray<readonly [PropClass, RegExp]> = [
	[
		"color",
		/^(?:color|background-color|border-color|border-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color|column-rule-color|scrollbar-color)$/,
	],
	["background", /^background$/],
	["shadow", /^(?:box-shadow|text-shadow)$/],
	[
		"border",
		/^(?:border|border-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?|border-width|border-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?-width|outline|outline-width|column-rule)$/,
	],
	[
		"motion",
		/^(?:transition|transition-(?:duration|delay|timing-function)|animation|animation-(?:duration|delay|timing-function))$/,
	],
	[
		"numeric",
		/^(?:padding(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|margin(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|font-size|border-radius|border-(?:top|bottom)-(?:left|right)-radius|border-(?:start|end)-(?:start|end)-radius|z-index)$/,
	],
];

function classify(property: string): PropClass | null {
	if (property.startsWith("--")) return "custom";
	for (const [cls, re] of CLASS_RES) if (re.test(property)) return cls;
	return null;
}

/** Bare tokens accepted in every checked property, lower-cased. */
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

/** CSS system colours (forced-colors palette) — the only colour keywords allowed. */
const SYSTEM_COLORS = new Set([
	"canvas",
	"canvastext",
	"linktext",
	"visitedtext",
	"activetext",
	"buttonface",
	"buttontext",
	"buttonborder",
	"field",
	"fieldtext",
	"highlight",
	"highlighttext",
	"selecteditem",
	"selecteditemtext",
	"mark",
	"marktext",
	"graytext",
	"accentcolor",
	"accentcolortext",
]);

const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double", "hidden", "groove", "ridge"]);

const BACKGROUND_KEYWORDS = new Set([
	"no-repeat",
	"repeat",
	"repeat-x",
	"repeat-y",
	"space",
	"round",
	"center",
	"top",
	"right",
	"bottom",
	"left",
	"cover",
	"contain",
	"fixed",
	"local",
	"scroll",
	"border-box",
	"padding-box",
	"content-box",
]);

/** Generic easings are not named Lattice curves (§2.1 "Named curves only"). */
const EASING_KEYWORDS = new Set([
	"ease",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"linear",
	"step-start",
	"step-end",
]);
const EASING_FUNCTIONS = new Set(["cubic-bezier", "steps", "linear"]);

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

/** Whether a bare identifier is acceptable for the property class. */
function keywordAllowed(lower: string, cls: PropClass): boolean {
	switch (cls) {
		case "color":
			return SYSTEM_COLORS.has(lower);
		case "background":
			return SYSTEM_COLORS.has(lower) || BACKGROUND_KEYWORDS.has(lower);
		case "shadow":
			return SYSTEM_COLORS.has(lower) || lower === "inset";
		case "border":
			return SYSTEM_COLORS.has(lower) || BORDER_STYLES.has(lower);
		case "motion":
			// transition property names, animation names and animation keywords — but no generic easing
			return !EASING_KEYWORDS.has(lower);
		case "numeric":
		case "custom":
			return false;
	}
}

/** Reason a single token is not allowed for the property class, or `null` if it is. */
function tokenProblem(token: string, cls: PropClass): string | null {
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
		if (keywordAllowed(lower, cls)) return null;
		if (cls === "motion") return `generic easing "${token}"`;
		return `keyword "${token}" is not a token`;
	}
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

const DECL_RE = /(?<![\w-])(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;{}]+?)\s*(?=[;}])/g;

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
			const cls = classify(property);
			if (cls) {
				for (const token of splitValue(value)) {
					const p = tokenProblem(token, cls);
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
