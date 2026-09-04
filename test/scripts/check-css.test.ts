// test/scripts/check-css.test.ts — C3 lint: numeric/colour CSS values must be Lattice tokens.
import { expect, it } from "bun:test";
import { findCssViolations } from "../../scripts/check-css";

const violating = (css: string) => findCssViolations({ "css/x.css": css });
const props = (css: string) => violating(css).map((v) => v.property);

it("flags raw px, hex colours and literal durations", () => {
	expect(props(".a { padding: 13px; }")).toEqual(["padding"]);
	expect(props(".a { color: #fff; }")).toEqual(["color"]);
	expect(props(".a { transition: all 200ms; }")).toEqual(["transition"]);
	expect(props(".a { margin-top: 2px; gap: 0.5rem; }")).toEqual(["margin-top", "gap"]);
	expect(props(".a { box-shadow: 0 0 0 2px var(--sl-color-focus); }")).toEqual(["box-shadow"]);
	expect(props(".a { background: rgb(255 255 255 / 0.08); }")).toEqual(["background"]);
	expect(props(".a { z-index: 5; font-size: 12px; border-radius: 50%; }")).toEqual([
		"z-index",
		"font-size",
		"border-radius",
	]);
	expect(props(".a { transition-duration: 0.2s; }")).toEqual(["transition-duration"]);
});

it("flags non-token custom-property references and easing literals", () => {
	expect(props(".a { padding: var(--space-3); }")).toEqual(["padding"]);
	expect(props(".a { transition: opacity var(--sl-motion-duration-1) ease-in; }")).toEqual([]);
	expect(
		props(".a { transition: opacity var(--sl-motion-duration-1) cubic-bezier(0.2, 0, 0, 1); }")
	).toEqual(["transition"]);
});

it("accepts tokens, calc() of tokens, and the allowed literals", () => {
	const ok = [
		".a { padding: var(--sl-space-3); }",
		".a { padding: var(--sl-space-3) var(--sl-space-4); }",
		".a { border: var(--sl-hairline) solid var(--sl-color-border-default); }",
		".a { transition: opacity var(--sl-motion-duration-2-5) var(--sl-motion-easing-standard); }",
		".a { transition: opacity var(--sl-motion-duration-2-5), color var(--sl-motion-duration-1); }",
		".a { margin: 0 auto; padding: 0; gap: 0; }",
		".a { box-shadow: var(--sl-shadow-raise); border-color: transparent; }",
		".a { box-shadow: 0 0 0 calc(var(--sl-unit) / 2) var(--sl-color-canvas), 0 0 0 var(--sl-unit) var(--sl-color-focus); }",
		".a { color: inherit; background: none; border-color: currentColor; }",
		".a { margin: calc(var(--sl-space-2) * -1); padding: calc(var(--sl-space-4) + 1px); }",
		".a { border-radius: 100%; z-index: var(--sl-z-toast); font-size: var(--sl-type-size-sm); }",
		".a { border-radius: var(--sl-radius-md) var(--sl-radius-md) 0 0; }",
		".a { color: CanvasText; background: Canvas; }",
		".a { padding: var(--sl-space-3) !important; }",
	];
	for (const css of ok) expect({ css, v: violating(css) }).toEqual({ css, v: [] });
});

it("leaves unlisted properties alone but still forbids hex colours anywhere", () => {
	expect(props(".a { width: 320px; height: 100vh; line-height: 1.2; flex: 1 1 0; }")).toEqual([]);
	expect(props(".a { border: 1px solid #22272d; }")).toEqual(["border"]);
	expect(props(".a { outline: 2px solid rgba(0,0,0,.5); }")).toEqual(["outline"]);
});

it("reports file and line and handles nested at-rules and comments", () => {
	const css = [
		"/* padding: 99px in a comment is fine */",
		"@media (prefers-reduced-motion: reduce) {",
		"\t.a:hover { transition-duration: var(--sl-motion-duration-2-5); }",
		'\t.b::before { content: "x"; padding: 3px; }',
		"}",
	].join("\n");
	const v = findCssViolations({ "css/base.css": css });
	expect(v).toHaveLength(1);
	expect(v[0]).toMatchObject({ file: "css/base.css", line: 4, property: "padding", value: "3px" });
});

it("skips the generated tokens stylesheet", () => {
	expect(
		findCssViolations({ "css/tokens.css": ":root { --sl-unit: 4px; } .a { padding: 4px; }" })
	).toEqual([]);
});
