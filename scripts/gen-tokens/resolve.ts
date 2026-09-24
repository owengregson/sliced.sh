// scripts/gen-tokens/resolve.ts — token references to concrete values, shared by both emitters.

import { type ColorRef, type ShadowLayer, type TypeStep, tokens } from "../../src/design/tokens";

export const PREFIX = "--sl-";

export type Theme = "dark" | "light";

/** `text.on-brand` → `text-on-brand`; `panelMin` → `panel-min`. */
export function kebab(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replaceAll(".", "-");
}

/** `text.on-brand` → `textOnBrand`; `hl.arrow-2` → `hlArrow2`. */
export function camel(key: string): string {
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

export function px(n: number): string {
	return n === 0 ? "0" : `${n}px`;
}

function shadowLayer(l: ShadowLayer): string {
	const parts = [px(l.x), px(l.y), px(l.blur)];
	if (l.spread !== undefined && l.spread !== 0) parts.push(px(l.spread));
	parts.push(resolveColor({ ref: l.color, alpha: l.alpha }));
	return `${l.inset ? "inset " : ""}${parts.join(" ")}`;
}

export function shadow(layers: readonly ShadowLayer[]): string {
	return layers.map(shadowLayer).join(", ");
}

export function unitMultiple(n: number): string {
	return n === 0 ? "0" : `calc(var(${PREFIX}unit) * ${n})`;
}

export function typeSize(step: TypeStep): number {
	return Math.round(tokens.type.base * tokens.type.ratio ** tokens.type.steps[step]);
}

export function typeSteps(): TypeStep[] {
	return Object.keys(tokens.type.steps) as TypeStep[];
}

export function durationsMs(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, mult] of Object.entries(tokens.motion.durations))
		out[k] = Math.round(tokens.motion.durationBase * mult);
	return out;
}
