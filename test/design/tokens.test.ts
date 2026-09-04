// test/design/tokens.test.ts — Lattice token generator (Task 7; Part I §10.2, Appendix F §2).
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CSS_OUT, generateTokens, renderTokens, TS_OUT } from "../../scripts/gen-tokens";
import { tokens } from "../../src/design/tokens";

/** Collapse all whitespace so `--sl-unit: 4px` and `--sl-unit:4px` compare equal. */
const squash = (s: string): string => s.replace(/\s+/g, "");

/** Extract the body of a top-level `selector{...}` block (first occurrence). */
function block(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) return "";
	const end = css.indexOf("}", start);
	return css.slice(start, end);
}

let css = "";
let ts = "";

beforeAll(() => {
	generateTokens(); // writes css/tokens.css + src/design/tokens.generated.ts for the import below
	const out = renderTokens();
	css = out.css;
	ts = out.ts;
});

describe("structural tokens", () => {
	it("emits the unit, hairline and unit-multiple spacing", () => {
		const root = squash(block(css, ":root"));
		expect(root).toContain("--sl-unit:4px;");
		expect(root).toContain("--sl-hairline:1px;");
		expect(root).toContain("--sl-space-4:calc(var(--sl-unit)*4);");
		expect(root).toContain("--sl-space-16:calc(var(--sl-unit)*16);");
		expect(root).toContain("--sl-radius-md:calc(var(--sl-unit)*3);");
		expect(root).toContain("--sl-radius-full:9999px;");
		expect(root).toContain("--sl-size-control-md:calc(var(--sl-unit)*9);");
		expect(root).toContain("--sl-size-icon-md:var(--sl-type-size-md);");
	});

	it("derives type sizes as round(13 × 1.2^n) and lattice-snapped leading", () => {
		const root = squash(block(css, ":root"));
		const expected: Record<string, number> = {
			xs: 11,
			sm: 13,
			md: 16,
			lg: 19,
			xl: 22,
			"2xl": 27,
			"3xl": 32,
			"4xl": 39,
			"5xl": 47,
			"6xl": 56,
		};
		for (const [step, n] of Object.entries(tokens.type.steps)) {
			const size = Math.round(tokens.type.base * tokens.type.ratio ** n);
			expect(size).toBe(expected[step] as number);
			expect(root).toContain(`--sl-type-size-${step}:${size}px;`);
			const leading = tokens.type.leading[step as keyof typeof tokens.type.leading];
			expect(leading % tokens.unit).toBe(0);
			expect(leading).toBeGreaterThanOrEqual(size);
			expect(root).toContain(`--sl-type-leading-${step}:${leading}px;`);
		}
	});

	it("emits motion durations as 80ms × k plus named easings and the z ladder", () => {
		const root = squash(block(css, ":root"));
		expect(root).toContain("--sl-motion-duration-1:80ms;");
		expect(root).toContain("--sl-motion-duration-1-5:120ms;");
		expect(root).toContain("--sl-motion-duration-2-5:200ms;");
		expect(root).toContain("--sl-motion-duration-4:320ms;");
		expect(root).toContain("--sl-motion-duration-6:480ms;");
		expect(root).toContain("--sl-motion-easing-standard:cubic-bezier(0.2,0,0,1);");
		expect(root).toContain("--sl-z-popover:30;");
		expect(root).toContain("--sl-layout-panel-standard:360px;");
	});
});

describe("semantic colours", () => {
	it("emits the dark block on :root and [data-theme=dark], light on [data-theme=light]", () => {
		expect(css).toContain('[data-theme="dark"] {');
		expect(css).toContain('[data-theme="light"] {');
		const root = squash(block(css, ":root"));
		const dark = squash(block(css, '[data-theme="dark"]'));
		const light = squash(block(css, '[data-theme="light"]'));
		expect(root).toContain("--sl-color-canvas:#15181C;");
		expect(dark).toContain("--sl-color-canvas:#15181C;");
		expect(light).toContain("--sl-color-canvas:#EEF1F5;");
		expect(light).toContain("--sl-color-text-on-brand:#6A4507;");
	});

	it("aliases --sl-color-accent to brand.500 in both themes", () => {
		const dark = squash(block(css, '[data-theme="dark"]')).toLowerCase();
		const light = squash(block(css, '[data-theme="light"]')).toLowerCase();
		expect(dark).toContain("--sl-color-accent:#f5a623;");
		expect(light).toContain("--sl-color-accent:#f5a623;");
	});

	it("resolves alpha references to rgb(r g b / a) with Appendix F alpha steps", () => {
		const dark = block(css, '[data-theme="dark"]');
		expect(dark).toContain("--sl-color-hl-from: rgb(245 166 35 / 0.32);");
		expect(dark).toContain("--sl-color-border-subtle: rgb(255 255 255 / 0.08);");
		expect(dark).toContain("--sl-color-text-disabled: rgb(216 222 230 / 0.32);");
		expect(dark).toContain("--sl-color-hl-arrow-3: rgb(79 127 176 / 0.48);");
		const light = block(css, '[data-theme="light"]');
		expect(light).toContain("--sl-color-text-disabled: rgb(21 24 28 / 0.32);");
		expect(light).toContain("--sl-color-danger-tint-strong: rgb(229 83 61 / 0.32);");
	});

	it("does not emit per-colour alpha ladders", () => {
		expect(css).not.toMatch(/--sl-color-[a-z-]+-a\d+:/);
	});

	it("emits theme-specific shadows composed from black/white alpha steps", () => {
		const dark = block(css, '[data-theme="dark"]');
		expect(dark).toContain("--sl-shadow-rim: inset 0 1px 0 rgb(255 255 255 / 0.04);");
		expect(dark).toContain(
			"--sl-shadow-raise: 0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.04);"
		);
		const light = block(css, '[data-theme="light"]');
		expect(light).toContain(
			"--sl-shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.08);"
		);
	});

	it("dark and light define the same semantic keys", () => {
		expect(Object.keys(tokens.color.light).sort()).toEqual(Object.keys(tokens.color.dark).sort());
	});
});

describe("type roles", () => {
	it("emits one .sl-type-<role> class per Appendix F §2.3 row", () => {
		for (const role of Object.keys(tokens.type.roles)) expect(css).toContain(`.sl-type-${role} {`);
		const label = squash(block(css, ".sl-type-label"));
		expect(label).toContain("font-family:var(--sl-type-family-ui);");
		expect(label).toContain("font-size:var(--sl-type-size-xs);");
		expect(label).toContain("line-height:var(--sl-type-leading-xs);");
		expect(label).toContain("font-weight:var(--sl-type-weight-medium);");
		expect(label).toContain("letter-spacing:var(--sl-type-tracking-loose);");
		const numeral = squash(block(css, ".sl-type-numeral-lg"));
		expect(numeral).toContain("font-family:var(--sl-type-family-display);");
		expect(numeral).toContain("font-feature-settings:var(--sl-type-features-numerals);");
	});
});

describe("TOKENS (generated TS)", () => {
	it("mirrors the CSS values so JS consumers never disagree with the stylesheet", async () => {
		const { TOKENS } = await import("../../src/design/tokens.generated");
		expect(TOKENS.color.dark.hlFrom).toBe("rgb(245 166 35 / 0.32)");
		expect(block(css, '[data-theme="dark"]')).toContain(
			`--sl-color-hl-from: ${TOKENS.color.dark.hlFrom};`
		);
		expect(TOKENS.color.dark.textOnBrand).toBe("#15181C");
		expect(TOKENS.color.light.textOnBrand).toBe("#6A4507");
		expect(TOKENS.color.dark.hlArrow2).toBe("rgb(111 163 214 / 0.48)");
		expect(TOKENS.motion.durationMs["2-5"]).toBe(200);
		expect(TOKENS.motion.easing.standard).toBe("cubic-bezier(0.2, 0, 0, 1)");
		expect(TOKENS.z.toast).toBe(40);
		expect(TOKENS.layout.panelMax).toBe(480);
		expect(TOKENS.type.size.md).toBe(16);
		expect(TOKENS.type.leading.lg).toBe(24);
		expect(ts).toContain("as const;");
		expect(ts).toContain("GENERATED");
	});
});

describe("determinism", () => {
	it("renders byte-identical output on repeated runs and on disk", () => {
		const a = renderTokens();
		const b = renderTokens();
		expect(a.css).toBe(b.css);
		expect(a.ts).toBe(b.ts);
		expect(readFileSync(CSS_OUT, "utf8")).toBe(css);
		expect(readFileSync(TS_OUT, "utf8")).toBe(ts);
	});
});
