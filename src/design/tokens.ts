// src/design/tokens.ts — "Lattice": the single source of truth for every design value (C3).
//
// One base unit; everything else derives from it by a fixed rule (Appendix F §2.1). Values are
// transcribed here exactly once from Appendix F §2.3–§2.5; `scripts/gen-tokens.ts` resolves the
// references below into `css/tokens.css` and `src/design/tokens.generated.ts` (`TOKENS`), so
// CSS and JS can never disagree. No other file may contain a hex colour, a px size or a duration.

/** Palette names (Appendix F §2.4) — the only hex values in the system. */
export const palette = {
	"charcoal.950": "#0F1215", // Deepest tier; only behind overlays.
	"charcoal.900": "#15181C", // Panel canvas (dark). Cool, matches logo disc.
	"charcoal.850": "#1B1F24", // Sunken surfaces (inputs, log).
	"charcoal.800": "#22272D", // Raised surface (move card, popover).
	"charcoal.700": "#2C323A", // Hover on raised; toggle track off.
	"charcoal.600": "#3A414B", // Borders (solid), slider track.
	"charcoal.500": "#59626E", // Disabled text, placeholder.
	"charcoal.400": "#8A94A3", // Secondary text.
	"charcoal.300": "#B7BFCB", // Tertiary/high-secondary text.
	"charcoal.200": "#D8DEE6", // Primary text (dark theme).
	"charcoal.100": "#EEF1F5", // Highest-contrast text; eval bar "white" on light theme.
	white: "#FFFFFF", // Alpha ramps only; eval bar white.
	black: "#000000", // Alpha ramps only.
	bone: "#F3EFE6", // Eval bar white half (warm so it reads as a piece colour, not UI).
	"slate.900": "#3A3531", // Eval bar black half (warm, distinct from UI charcoal).
	"brand.300": "#FFC65C", // Brand text on dark, hover.
	"brand.500": "#F5A623", // Brand core (logo orange). Fills, focus, hero SAN.
	"brand.700": "#C7800E", // Pressed, dark-theme border of brand fills.
	"brand.900": "#6A4507", // Text on brand fills (light theme only).
	"line.500": "#6FA3D6", // Secondary PV arrow / line 2.
	"line.600": "#4F7FB0", // Line 3.
	"success.500": "#4FBF7A", // Verified, attached, connected.
	"warn.500": "#E6C34A", // Warnings (yellow, distinct from brand by hue and by icon).
	"danger.300": "#FF8A7A", // Danger text on dark.
	"danger.500": "#E5533D", // Auto-play armed, errors.
	"danger.700": "#A8301F", // Danger pressed.
} as const;

export type PaletteName = keyof typeof palette;

/** The only alphas allowed (Appendix F §2.1). */
export const alpha = {
	a4: 0.04,
	a8: 0.08,
	a12: 0.12,
	a16: 0.16,
	a24: 0.24,
	a32: 0.32,
	a48: 0.48,
	a64: 0.64,
} as const;

export type AlphaStep = keyof typeof alpha;

/** A semantic colour is a palette colour, optionally at one alpha step — never a hex. */
export interface ColorRef {
	readonly ref: PaletteName;
	readonly alpha?: AlphaStep;
}

/** One layer of a shadow: lattice offsets in px, black/white at an alpha step. */
export interface ShadowLayer {
	readonly inset?: true;
	readonly x: number;
	readonly y: number;
	readonly blur: number;
	readonly spread?: number;
	readonly color: "black" | "white";
	readonly alpha: AlphaStep;
}

/** Semantic colour keys, in Appendix F §2.5 order (dotted; `-` inside a segment is kept). */
const darkColors = {
	// canvas & surfaces
	canvas: { ref: "charcoal.900" },
	"surface.sunken": { ref: "charcoal.850" },
	"surface.raised": { ref: "charcoal.800" },
	"surface.hover": { ref: "charcoal.700" },
	"surface.overlay": { ref: "charcoal.950", alpha: "a64" },
	// borders
	"border.subtle": { ref: "white", alpha: "a8" },
	"border.default": { ref: "white", alpha: "a12" },
	"border.strong": { ref: "charcoal.600" },
	"border.brand": { ref: "brand.700" },
	// text tiers
	"text.primary": { ref: "charcoal.200" },
	"text.secondary": { ref: "charcoal.400" },
	"text.tertiary": { ref: "charcoal.500" },
	"text.disabled": { ref: "charcoal.200", alpha: "a32" },
	"text.on-brand": { ref: "charcoal.900" },
	"text.on-danger": { ref: "white" },
	// brand
	brand: { ref: "brand.500" },
	"brand.text": { ref: "brand.300" },
	"brand.pressed": { ref: "brand.700" },
	"brand.tint": { ref: "brand.500", alpha: "a12" },
	"brand.tint-strong": { ref: "brand.500", alpha: "a24" },
	focus: { ref: "brand.500" },
	// status
	success: { ref: "success.500" },
	"success.tint": { ref: "success.500", alpha: "a12" },
	warn: { ref: "warn.500" },
	"warn.tint": { ref: "warn.500", alpha: "a12" },
	danger: { ref: "danger.500" },
	"danger.text": { ref: "danger.300" },
	"danger.pressed": { ref: "danger.700" },
	"danger.tint": { ref: "danger.500", alpha: "a12" },
	"danger.tint-strong": { ref: "danger.500", alpha: "a24" },
	// eval bar
	"eval.white": { ref: "bone" },
	"eval.black": { ref: "slate.900" },
	"eval.divider": { ref: "white", alpha: "a24" },
	// board highlights (injected into the host page)
	"hl.from": { ref: "brand.500", alpha: "a32" },
	"hl.to": { ref: "brand.500", alpha: "a48" },
	"hl.arrow": { ref: "brand.500", alpha: "a64" },
	"hl.arrow-2": { ref: "line.500", alpha: "a48" },
	"hl.arrow-3": { ref: "line.600", alpha: "a48" },
	"hl.preview": { ref: "line.500", alpha: "a64" },
} as const satisfies Record<string, ColorRef>;

export type SemanticColorKey = keyof typeof darkColors;

/**
 * Light theme (Appendix F §2.5 `[data-theme="light"]`). Same keys as dark. Board highlights are
 * not overridden by the light block in §2.5 (they are painted on the host page, which stays dark),
 * so they repeat the dark references here to keep the key sets identical.
 */
const lightColors = {
	canvas: { ref: "charcoal.100" },
	"surface.sunken": { ref: "charcoal.200" },
	"surface.raised": { ref: "white" },
	"surface.hover": { ref: "charcoal.200" },
	"surface.overlay": { ref: "charcoal.950", alpha: "a32" },
	"border.subtle": { ref: "black", alpha: "a8" },
	"border.default": { ref: "black", alpha: "a12" },
	"border.strong": { ref: "charcoal.300" },
	"border.brand": { ref: "brand.700" },
	"text.primary": { ref: "charcoal.900" },
	"text.secondary": { ref: "charcoal.500" },
	"text.tertiary": { ref: "charcoal.400" },
	"text.disabled": { ref: "charcoal.900", alpha: "a32" },
	"text.on-brand": { ref: "brand.900" },
	"text.on-danger": { ref: "white" },
	brand: { ref: "brand.500" },
	"brand.text": { ref: "brand.700" }, // brand.700 for contrast on light
	"brand.pressed": { ref: "brand.700" },
	"brand.tint": { ref: "brand.500", alpha: "a16" },
	"brand.tint-strong": { ref: "brand.500", alpha: "a32" },
	focus: { ref: "brand.700" },
	success: { ref: "success.500" },
	"success.tint": { ref: "success.500", alpha: "a16" },
	warn: { ref: "warn.500" },
	"warn.tint": { ref: "warn.500", alpha: "a24" },
	danger: { ref: "danger.500" },
	"danger.text": { ref: "danger.700" },
	"danger.pressed": { ref: "danger.700" },
	"danger.tint": { ref: "danger.500", alpha: "a16" },
	"danger.tint-strong": { ref: "danger.500", alpha: "a32" },
	"eval.white": { ref: "white" },
	"eval.black": { ref: "slate.900" },
	"eval.divider": { ref: "black", alpha: "a24" },
	"hl.from": { ref: "brand.500", alpha: "a32" },
	"hl.to": { ref: "brand.500", alpha: "a48" },
	"hl.arrow": { ref: "brand.500", alpha: "a64" },
	"hl.arrow-2": { ref: "line.500", alpha: "a48" },
	"hl.arrow-3": { ref: "line.600", alpha: "a48" },
	"hl.preview": { ref: "line.500", alpha: "a64" },
} as const satisfies Record<SemanticColorKey, ColorRef>;

/** Shadows (Appendix F §2.5): dark theme = rims, not drops. */
const darkShadows = {
	rim: [{ inset: true, x: 0, y: 1, blur: 0, color: "white", alpha: "a4" }],
	inset: [{ inset: true, x: 0, y: 1, blur: 2, color: "black", alpha: "a24" }],
	raise: [
		{ x: 0, y: 0, blur: 0, spread: 1, color: "white", alpha: "a8" },
		{ inset: true, x: 0, y: 1, blur: 0, color: "white", alpha: "a4" },
	],
	overlay: [
		{ x: 0, y: 8, blur: 24, color: "black", alpha: "a48" },
		{ x: 0, y: 0, blur: 0, spread: 1, color: "white", alpha: "a8" },
	],
} as const satisfies Record<string, readonly ShadowLayer[]>;

export type ShadowKey = keyof typeof darkShadows;

const lightShadows = {
	rim: [{ inset: true, x: 0, y: 1, blur: 0, color: "white", alpha: "a64" }],
	inset: [{ inset: true, x: 0, y: 1, blur: 2, color: "black", alpha: "a8" }],
	raise: [
		{ x: 0, y: 1, blur: 2, color: "black", alpha: "a8" },
		{ x: 0, y: 0, blur: 0, spread: 1, color: "black", alpha: "a8" },
	],
	overlay: [
		{ x: 0, y: 8, blur: 24, color: "black", alpha: "a16" },
		{ x: 0, y: 0, blur: 0, spread: 1, color: "black", alpha: "a8" },
	],
} as const satisfies Record<ShadowKey, readonly ShadowLayer[]>;

/** Type scale step names (Appendix F §2.1). */
export type TypeStep = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl";

/** A type role: the only font combinations the UI uses (Appendix F §2.3 table). */
export interface TypeRole {
	readonly family: "ui" | "display" | "mono";
	readonly size: TypeStep;
	readonly weight: "regular" | "medium" | "semibold";
	readonly tracking: "tight" | "normal" | "loose";
}

export const tokens = {
	/** px; the lattice. */
	unit: 4,
	/** multipliers → `--sl-space-N = unit × N` (0 4 8 12 16 20 24 32 40 48 64 px). */
	space: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 8: 8, 10: 10, 12: 12, 16: 16 },
	/** control heights in unit multiples (28/36/44); icon sizes = type sizes (13/16/19). */
	size: {
		control: { sm: 7, md: 9, lg: 11 },
		icon: { sm: "type.sm", md: "type.md", lg: "type.lg" },
		touch: 11,
		rail: 2,
		hairline: "1px",
		/** Fixed mono columns of the Engine view's log panes (Appendix F §4.7): 8ch time, 5ch kind. */
		column: { logTime: "8ch", logKind: "5ch" },
		/** Max height of the rationale / live log panes in unit multiples (192px). */
		logPane: 48,
	},
	/** unit multiples (4 8 12 16 24) + pill. */
	radius: { xs: 1, sm: 2, md: 3, lg: 4, xl: 6, full: "9999px" },
	type: {
		family: {
			ui: '"Geist", "Inter", system-ui, sans-serif',
			display: '"Bricolage Grotesque", "Archivo", "Geist", sans-serif',
			mono: '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
		},
		/** size = round(base × ratio^n) — minor third, base 13px for panel density. */
		base: 13,
		ratio: 1.2,
		steps: { xs: -1, sm: 0, md: 1, lg: 2, xl: 3, "2xl": 4, "3xl": 5, "4xl": 6, "5xl": 7, "6xl": 8 },
		/**
		 * Line-height snapped to the lattice (Appendix F §2.1/§2.3 table). The table is
		 * transcribed rather than derived: the generator verifies each value is a unit multiple ≥ size.
		 */
		leading: {
			xs: 16,
			sm: 20,
			md: 24,
			lg: 24,
			xl: 28,
			"2xl": 32,
			"3xl": 40,
			"4xl": 48,
			"5xl": 56,
			"6xl": 64,
		},
		weight: { regular: 400, medium: 500, semibold: 600 },
		tracking: { tight: "-0.02em", normal: "0", loose: "0.02em" },
		features: { numerals: '"tnum" 1, "lnum" 1', mono: '"liga" 0' },
		/** Appendix F §2.3 type-role table → `.sl-type-<role>` classes. */
		roles: {
			label: { family: "ui", size: "xs", weight: "medium", tracking: "loose" },
			body: { family: "ui", size: "sm", weight: "regular", tracking: "normal" },
			"body-strong": { family: "ui", size: "sm", weight: "semibold", tracking: "normal" },
			title: { family: "ui", size: "md", weight: "semibold", tracking: "tight" },
			"numeral-sm": { family: "display", size: "lg", weight: "semibold", tracking: "normal" },
			"numeral-md": { family: "display", size: "2xl", weight: "semibold", tracking: "tight" },
			"numeral-lg": { family: "display", size: "4xl", weight: "semibold", tracking: "tight" },
			"move-sm": { family: "display", size: "3xl", weight: "semibold", tracking: "tight" },
			"move-lg": { family: "display", size: "6xl", weight: "semibold", tracking: "tight" },
			mono: { family: "mono", size: "sm", weight: "regular", tracking: "normal" },
			"mono-xs": { family: "mono", size: "xs", weight: "regular", tracking: "normal" },
		} satisfies Record<string, TypeRole>,
	},
	color: {
		palette,
		alpha,
		dark: darkColors,
		light: lightColors,
		/**
		 * `prefers-contrast: more` overrides (Appendix F §8.4): text-secondary maps to charcoal.300.
		 * Only the dark theme is specified; borders → border-strong is handled in base.css.
		 */
		highContrast: {
			dark: { "text.secondary": { ref: "charcoal.300" } },
			light: {},
		} satisfies Record<"dark" | "light", Partial<Record<SemanticColorKey, ColorRef>>>,
	},
	shadow: { dark: darkShadows, light: lightShadows },
	motion: {
		/** ms; every duration is `durationBase × k`. */
		durationBase: 80,
		durations: { 1: 1, "1-5": 1.5, "2-5": 2.5, 4: 4, 6: 6 },
		easing: {
			standard: "cubic-bezier(0.2, 0, 0, 1)",
			emphasized: "cubic-bezier(0.32, 0.72, 0, 1)",
			exit: "cubic-bezier(0.4, 0, 1, 1)",
			/** Real-time only (Appendix F §5.10, §6.1): the countdown ring and the arm-hold fill. */
			linear: "linear",
			spring:
				"linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001)",
		},
	},
	/** Ten-step ladder. */
	z: { base: 0, rail: 10, sticky: 20, popover: 30, toast: 40, overlay: 50 },
	/** Panel width breakpoints in px (Appendix F §8.1) — the only px widths allowed. */
	layout: { panelMin: 320, panelStandard: 360, panelComfortable: 420, panelMax: 480 },
} as const;

export type Tokens = typeof tokens;
export type TypeRoleName = keyof Tokens["type"]["roles"];
