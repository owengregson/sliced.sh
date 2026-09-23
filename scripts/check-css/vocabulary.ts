// scripts/check-css/vocabulary.ts — the rule registry: which properties are checked, in which
// class, and which bare keywords each class accepts beside tokens and the universal literals.

/**
 * Property classes. Each checked property accepts tokens/allowed literals plus a class-specific
 * keyword set; everything else (raw numbers, named colours, generic easings, `thin`, …) fails.
 */
export type PropClass =
	| "color"
	| "background"
	| "shadow"
	| "border"
	| "motion"
	| "numeric"
	| "custom";

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

/** The class a property is checked under, or `null` when only the colour-literal scan applies. */
export function classify(property: string): PropClass | null {
	if (property.startsWith("--")) return "custom";
	for (const [cls, re] of CLASS_RES) if (re.test(property)) return cls;
	return null;
}

/** Bare tokens accepted in every checked property, lower-cased. */
export const LITERALS = new Set([
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

/** Easing functions rejected inside a motion value. */
export const EASING_FUNCTIONS = new Set(["cubic-bezier", "steps", "linear"]);

/** Whether a bare, lower-cased identifier is acceptable for each property class. */
export const KEYWORD_POLICY: Readonly<Record<PropClass, (lower: string) => boolean>> = {
	color: (lower) => SYSTEM_COLORS.has(lower),
	background: (lower) => SYSTEM_COLORS.has(lower) || BACKGROUND_KEYWORDS.has(lower),
	shadow: (lower) => SYSTEM_COLORS.has(lower) || lower === "inset",
	border: (lower) => SYSTEM_COLORS.has(lower) || BORDER_STYLES.has(lower),
	// transition property names, animation names and animation keywords — but no generic easing
	motion: (lower) => !EASING_KEYWORDS.has(lower),
	numeric: () => false,
	custom: () => false,
};
