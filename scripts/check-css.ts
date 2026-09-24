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
//
// The property classes and their keyword policies are the registry in `check-css/vocabulary.ts`;
// `check-css/values.ts` judges a value token by token. This file walks the stylesheets.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { splitValue, tokenProblem } from "./check-css/values";
import { classify } from "./check-css/vocabulary";
import { posixRelative, ROOT } from "./lib/paths";
import { failOnFindings } from "./lib/report";

export { splitValue } from "./check-css/values";

export interface CssViolation {
	file: string;
	line: number;
	property: string;
	value: string;
	reason: string;
}

const GENERATED = new Set(["css/tokens.css"]);

const COLOR_LITERAL_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

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

function walk(dir: string, acc: Record<string, string>): void {
	for (const e of readdirSync(dir).sort()) {
		const p = path.join(dir, e);
		if (statSync(p).isDirectory()) walk(p, acc);
		else if (p.endsWith(".css")) acc[posixRelative(ROOT, p)] = readFileSync(p, "utf8");
	}
}

export function checkCss(root = "css"): void {
	const files: Record<string, string> = {};
	walk(path.resolve(ROOT, root), files);
	failOnFindings(
		findCssViolations(files),
		(v) => `${v.file}:${v.line}: ${v.property}: ${v.value} — ${v.reason}`,
		(n) => `${n} CSS token violation(s)`
	);
}

if (import.meta.main) {
	checkCss();
	console.log("check-css: ok");
}
