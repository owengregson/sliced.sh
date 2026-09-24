// scripts/gen-tokens.ts — Lattice generator (Part I §10.2, Appendix F §2).
//
// Reads `src/design/tokens.ts` and emits two gitignored build artefacts:
//   css/tokens.css                  — `:root` structural tokens + dark semantic colours (also on
//                                     `[data-theme="dark"]`), light colours on `[data-theme="light"]`,
//                                     and the `.sl-type-<role>` utility classes.
//   src/design/tokens.generated.ts  — `TOKENS` for JS consumers (animation manager, highlight colours).
// Output is deterministic: the emission order is the declaration order in tokens.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderCss } from "./gen-tokens/css";
import { renderTs } from "./gen-tokens/ts";
import { ROOT } from "./lib/paths";

export { renderCss } from "./gen-tokens/css";
export { resolveColor } from "./gen-tokens/resolve";
export { renderTs } from "./gen-tokens/ts";

export const CSS_OUT = path.join(ROOT, "css", "tokens.css");
export const TS_OUT = path.join(ROOT, "src", "design", "tokens.generated.ts");

export interface GeneratedTokens {
	css: string;
	ts: string;
}

/** Pure render (no I/O) — used by tests to prove determinism. */
export function renderTokens(): GeneratedTokens {
	return { css: renderCss(), ts: renderTs() };
}

/** Render and write both artefacts (build step `gen-tokens`). */
export function generateTokens(): void {
	const out = renderTokens();
	mkdirSync(path.dirname(CSS_OUT), { recursive: true });
	mkdirSync(path.dirname(TS_OUT), { recursive: true });
	writeFileSync(CSS_OUT, out.css);
	writeFileSync(TS_OUT, out.ts);
}

if (import.meta.main) {
	generateTokens();
	console.log(`wrote ${path.relative(ROOT, CSS_OUT)} and ${path.relative(ROOT, TS_OUT)}`);
}
