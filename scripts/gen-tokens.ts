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
import { type ColorRef, type ShadowLayer, type TypeStep, tokens } from "../src/design/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
export const CSS_OUT = path.join(ROOT, "css", "tokens.css");
export const TS_OUT = path.join(ROOT, "src", "design", "tokens.generated.ts");

const PREFIX = "--sl-";

type Theme = "dark" | "light";
type Decl = readonly [name: string, value: string];

/** `text.on-brand` → `text-on-brand`; `panelMin` → `panel-min`. */
function kebab(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replaceAll(".", "-");
}

/** `text.on-brand` → `textOnBrand`; `hl.arrow-2` → `hlArrow2`. */
function camel(key: string): string {
	return key
		.split(/[.-]/)
		.map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("");
}

function hexToRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Resolve a palette reference (+ optional alpha step) to a CSS colour. */
export function resolveColor(ref: ColorRef): string {
	const hex: string = tokens.color.palette[ref.ref];
	if (ref.alpha === undefined) return hex;
	const [r, g, b] = hexToRgb(hex);
	return `rgb(${r} ${g} ${b} / ${tokens.color.alpha[ref.alpha]})`;
}

function px(n: number): string {
	return n === 0 ? "0" : `${n}px`;
}

function shadowLayer(l: ShadowLayer): string {
	const parts = [px(l.x), px(l.y), px(l.blur)];
	if (l.spread !== undefined && l.spread !== 0) parts.push(px(l.spread));
	parts.push(resolveColor({ ref: l.color, alpha: l.alpha }));
	return `${l.inset ? "inset " : ""}${parts.join(" ")}`;
}

function shadow(layers: readonly ShadowLayer[]): string {
	return layers.map(shadowLayer).join(", ");
}

function unitMultiple(n: number): string {
	return n === 0 ? "0" : `calc(var(${PREFIX}unit) * ${n})`;
}

function typeSize(step: TypeStep): number {
	return Math.round(tokens.type.base * tokens.type.ratio ** tokens.type.steps[step]);
}

function typeSteps(): TypeStep[] {
	return Object.keys(tokens.type.steps) as TypeStep[];
}

/** Structural tokens (Appendix F §2.3), theme-independent. */
function structuralDecls(): Decl[] {
	const out: Decl[] = [];
	const add = (name: string, value: string | number): void => {
		out.push([`${PREFIX}${name}`, String(value)]);
	};
	add("unit", px(tokens.unit));
	add("hairline", tokens.size.hairline);
	for (const [k, n] of Object.entries(tokens.space)) add(`space-${k}`, unitMultiple(n));
	for (const [k, n] of Object.entries(tokens.size.control))
		add(`size-control-${k}`, unitMultiple(n));
	for (const [k, ref] of Object.entries(tokens.size.icon)) {
		const step = ref.slice("type.".length);
		add(`size-icon-${k}`, `var(${PREFIX}type-size-${step})`);
	}
	add("size-touch", unitMultiple(tokens.size.touch));
	add("size-rail", unitMultiple(tokens.size.rail));
	for (const [k, v] of Object.entries(tokens.radius))
		add(`radius-${k}`, typeof v === "number" ? unitMultiple(v) : v);
	for (const [k, v] of Object.entries(tokens.type.family)) add(`type-family-${k}`, v);
	for (const step of typeSteps()) {
		const size = typeSize(step);
		const leading = tokens.type.leading[step];
		if (leading % tokens.unit !== 0 || leading < size)
			throw new Error(`type.leading.${step}=${leading} is not a lattice multiple ≥ ${size}`);
		add(`type-size-${step}`, px(size));
		add(`type-leading-${step}`, px(leading));
	}
	for (const [k, v] of Object.entries(tokens.type.weight)) add(`type-weight-${k}`, v);
	for (const [k, v] of Object.entries(tokens.type.tracking)) add(`type-tracking-${k}`, v);
	for (const [k, v] of Object.entries(tokens.type.features)) add(`type-features-${k}`, v);
	for (const [k, v] of Object.entries(durationsMs())) add(`motion-duration-${k}`, `${v}ms`);
	for (const [k, v] of Object.entries(tokens.motion.easing)) add(`motion-easing-${k}`, v);
	for (const [k, v] of Object.entries(tokens.z)) add(`z-${k}`, v);
	for (const [k, v] of Object.entries(tokens.layout)) add(`layout-${kebab(k)}`, px(v));
	return out;
}

function durationsMs(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, mult] of Object.entries(tokens.motion.durations))
		out[k] = Math.round(tokens.motion.durationBase * mult);
	return out;
}

/** Semantic colours + shadows for one theme (Appendix F §2.5), plus the `--sl-color-accent` alias. */
function themeDecls(theme: Theme): Decl[] {
	const out: Decl[] = [];
	for (const [key, ref] of Object.entries(tokens.color[theme]))
		out.push([`${PREFIX}color-${kebab(key)}`, resolveColor(ref)]);
	out.push([`${PREFIX}color-accent`, resolveColor({ ref: "brand.500" })]);
	for (const [key, layers] of Object.entries(tokens.shadow[theme]))
		out.push([`${PREFIX}shadow-${key}`, shadow(layers)]);
	return out;
}

function highContrastDecls(theme: Theme): Decl[] {
	return Object.entries(tokens.color.highContrast[theme]).map(
		([key, ref]) => [`${PREFIX}color-${kebab(key)}`, resolveColor(ref)] as const
	);
}

function typeRoleDecls(role: keyof typeof tokens.type.roles): Decl[] {
	const r = tokens.type.roles[role];
	const out: Decl[] = [
		["font-family", `var(${PREFIX}type-family-${r.family})`],
		["font-size", `var(${PREFIX}type-size-${r.size})`],
		["line-height", `var(${PREFIX}type-leading-${r.size})`],
		["font-weight", `var(${PREFIX}type-weight-${r.weight})`],
		["letter-spacing", `var(${PREFIX}type-tracking-${r.tracking})`],
	];
	if (r.family === "display")
		out.push(["font-feature-settings", `var(${PREFIX}type-features-numerals)`]);
	if (r.family === "mono") out.push(["font-feature-settings", `var(${PREFIX}type-features-mono)`]);
	return out;
}

function rule(selector: string, decls: readonly Decl[], indent = ""): string {
	const body = decls.map(([n, v]) => `${indent}\t${n}: ${v};`).join("\n");
	return `${indent}${selector} {\n${body}\n${indent}}\n`;
}

export function renderCss(): string {
	const parts: string[] = [
		"/* GENERATED by scripts/gen-tokens.ts from src/design/tokens.ts — do not edit. */\n",
		rule(":root", [...structuralDecls(), ...themeDecls("dark")]),
		rule('[data-theme="dark"]', themeDecls("dark")),
		rule('[data-theme="light"]', themeDecls("light")),
	];
	const hcDark = highContrastDecls("dark");
	const hcLight = highContrastDecls("light");
	if (hcDark.length || hcLight.length) {
		let media = "@media (prefers-contrast: more) {\n";
		if (hcDark.length) media += rule(':root, [data-theme="dark"]', hcDark, "\t");
		if (hcLight.length) media += rule('[data-theme="light"]', hcLight, "\t");
		parts.push(`${media}}\n`);
	}
	for (const role of Object.keys(tokens.type.roles) as Array<keyof typeof tokens.type.roles>)
		parts.push(rule(`.sl-type-${role}`, typeRoleDecls(role)));
	return parts.join("\n");
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

/** Deterministic TS literal: quotes keys only when needed, tabs, trailing commas. */
function literal(v: Json, depth: number): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	const pad = "\t".repeat(depth + 1);
	const close = "\t".repeat(depth);
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		return `[\n${v.map((x) => `${pad}${literal(x, depth + 1)},`).join("\n")}\n${close}]`;
	}
	const entries = Object.entries(v as { readonly [k: string]: Json });
	if (entries.length === 0) return "{}";
	const body = entries
		.map(([k, x]) => {
			const key = /^(?:[A-Za-z_$][\w$]*|\d+)$/.test(k) ? k : JSON.stringify(k);
			return `${pad}${key}: ${literal(x, depth + 1)},`;
		})
		.join("\n");
	return `{\n${body}\n${close}}`;
}

function themeColors(theme: Theme): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, ref] of Object.entries(tokens.color[theme])) out[camel(key)] = resolveColor(ref);
	out.accent = resolveColor({ ref: "brand.500" });
	return out;
}

function themeShadows(theme: Theme): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, layers] of Object.entries(tokens.shadow[theme])) out[key] = shadow(layers);
	return out;
}

function pxMap(m: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, n] of Object.entries(m)) out[k] = n * tokens.unit;
	return out;
}

/** Radius in px: unit multiples resolved, `full` parsed from its px literal. */
function radiusPx(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(tokens.radius))
		out[k] = typeof v === "number" ? v * tokens.unit : Number.parseInt(v, 10);
	return out;
}

export function renderTs(): string {
	const size: Record<string, number> = {};
	const leading: Record<string, number> = {};
	for (const step of typeSteps()) {
		size[step] = typeSize(step);
		leading[step] = tokens.type.leading[step];
	}
	const iconSize: Record<string, number> = {};
	for (const [k, ref] of Object.entries(tokens.size.icon)) {
		const resolved = size[ref.slice("type.".length)];
		if (resolved === undefined) throw new Error(`size.icon.${k} references unknown step "${ref}"`);
		iconSize[k] = resolved;
	}
	const data: Json = {
		unit: tokens.unit,
		space: pxMap(tokens.space),
		size: {
			control: pxMap(tokens.size.control),
			icon: iconSize,
			touch: tokens.size.touch * tokens.unit,
			rail: tokens.size.rail * tokens.unit,
			hairline: 1,
		},
		radius: radiusPx(),
		color: { dark: themeColors("dark"), light: themeColors("light") },
		shadow: { dark: themeShadows("dark"), light: themeShadows("light") },
		motion: { durationMs: durationsMs(), easing: tokens.motion.easing },
		layout: tokens.layout,
		type: {
			family: tokens.type.family,
			size,
			leading,
			weight: tokens.type.weight,
			tracking: tokens.type.tracking,
			features: tokens.type.features,
		},
		z: tokens.z,
	};
	return [
		"// GENERATED by scripts/gen-tokens.ts from src/design/tokens.ts — do not edit.",
		"// Resolved Lattice tokens for JS consumers; values are byte-identical to css/tokens.css.",
		`export const TOKENS = ${literal(data, 0)} as const;`,
		"",
		"export type Tokens = typeof TOKENS;",
		'export type ThemeName = keyof Tokens["color"];',
		"",
	].join("\n");
}

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
