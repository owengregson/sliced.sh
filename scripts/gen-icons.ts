// scripts/gen-icons.ts — build-time icon verification (Part I §10.3).
//
// Parses the vendored Font Awesome stylesheet for `.fa-<name>` selectors and asserts that every
// `fa-*` glyph token of every `ICONS` value exists. Style classes (`fa-solid`, `fa-regular`,
// `fa-brands`, `fa-fw`, `fa-spin`) are known style tokens, not glyph names. An unknown glyph
// fails the build, so a typo in the registry can never ship as an empty square.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ICON_STYLE_CLASSES, ICONS } from "../src/design/icons";

const ROOT = path.resolve(import.meta.dir, "..");
export const FONTAWESOME_CSS = path.join(
	ROOT,
	"assets",
	"vendor",
	"fontawesome",
	"css",
	"all.min.css"
);

export interface MissingIcon {
	name: string;
	token: string;
}

/** Every `.fa-<name>` selector in the stylesheet (glyphs and utilities alike). */
export function parseFaClasses(css: string): Set<string> {
	const out = new Set<string>();
	for (const m of css.matchAll(/\.fa-([a-z0-9-]+)/g)) if (m[1] !== undefined) out.add(`fa-${m[1]}`);
	return out;
}

/** Pure check: which registry entries reference a class the stylesheet does not define. */
export function findMissingIcons(css: string, icons: Record<string, string>): MissingIcon[] {
	const known = parseFaClasses(css);
	const styles = new Set<string>(ICON_STYLE_CLASSES);
	const out: MissingIcon[] = [];
	for (const [name, classes] of Object.entries(icons))
		for (const token of classes.split(/\s+/)) {
			if (token === "") continue;
			if (styles.has(token)) {
				if (!known.has(token)) out.push({ name, token });
				continue;
			}
			if (!token.startsWith("fa-") || !known.has(token)) out.push({ name, token });
		}
	return out;
}

export function verifyIcons(cssPath: string = FONTAWESOME_CSS): void {
	const css = readFileSync(cssPath, "utf8");
	const missing = findMissingIcons(css, ICONS);
	if (missing.length) {
		for (const m of missing)
			console.error(
				`icon "${m.name}": class "${m.token}" not found in ${path.relative(ROOT, cssPath)}`
			);
		throw new Error(`${missing.length} unknown icon class(es)`);
	}
}

if (import.meta.main) {
	verifyIcons();
	console.log(
		`verified ${Object.keys(ICONS).length} icons against ${path.relative(ROOT, FONTAWESOME_CSS)}`
	);
}
