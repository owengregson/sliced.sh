// scripts/vendor-engine/fonts.ts — Task 27: the vendored UI fonts (`assets/fonts/`).
// Kept as a separate, self-contained block so other lanes' additions merge cleanly.

import path from "node:path";
import { describeFiles, type VendoredFile } from "../lib/fs";
import { ROOT } from "../lib/paths";

/** Extension-relative directory holding the subset fonts referenced by `css/base.css`. */
export const FONTS_DIR = "assets/fonts/";

export interface FontFamilyNotice {
	/** Family name exactly as declared in `@font-face` / `tokens.type.family`. */
	family: string;
	/** Subset woff2 shipped in `FONTS_DIR`. */
	file: string;
	/** OFL text shipped alongside. */
	licenseFile: string;
	/** Upstream package / repository and version the subset was cut from. */
	source: string;
	version: string;
	copyright: string;
	/** Retained variation axes after instancing (`fontTools.varLib.instancer`). */
	axes: string;
}

export interface VendoredFont extends FontFamilyNotice, VendoredFile {}

export const FONT_FAMILIES: readonly FontFamilyNotice[] = [
	{
		family: "Geist",
		file: "Geist-Variable.woff2",
		licenseFile: "LICENSE-Geist.txt",
		source:
			"npm `geist` (https://github.com/vercel/geist-font), `dist/fonts/geist-sans/Geist-Variable.ttf`",
		version: "geist@1.7.2 (font version 1.800)",
		copyright: "Copyright (c) 2023 Vercel, in collaboration with basement.studio",
		axes: "wght 400–600",
	},
	{
		family: "Geist Mono",
		file: "GeistMono-Variable.woff2",
		licenseFile: "LICENSE-GeistMono.txt",
		source:
			"npm `geist` (https://github.com/vercel/geist-font), `dist/fonts/geist-mono/GeistMono-Variable.ttf`",
		version: "geist@1.7.2 (font version 1.700)",
		copyright: "Copyright (c) 2023 Vercel, in collaboration with basement.studio",
		axes: "wght 400–500",
	},
	{
		family: "Bricolage Grotesque",
		file: "BricolageGrotesque-Variable.woff2",
		licenseFile: "LICENSE-BricolageGrotesque.txt",
		source:
			"google/fonts `ofl/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf` (upstream https://github.com/ateliertriay/bricolage @ 84745e5b)",
		version: "font version 1.001",
		copyright:
			"Copyright 2022 The Bricolage Grotesque Project Authors (https://github.com/ateliertriay/bricolage)",
		axes: "opsz 12–96, wght 400–600 (wdth pinned to 100)",
	},
];

/** Google Fonts' `latin` range plus the glyphs the panel copy uses (× → ½ − · … – — ← ↑ ↓ ≤ ≥ § ±) and the chess figurines. */
export const FONT_UNICODES =
	"U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+2264,U+2265,U+2654-265F,U+FEFF,U+FFFD";

/** CSS `unicode-range` value for the `@font-face` blocks in `css/base.css` (same ranges). */
export const FONT_UNICODE_RANGE_CSS = FONT_UNICODES.split(",").join(", ");

/** Appendix F §9 Q4: the three subsets together must stay within this many bytes. */
export const FONT_BUDGET_BYTES = 260 * 1024;

/** Sizes + hashes of the shipped subsets (each family's `file` must exist). */
export async function describeFonts(dir = path.join(ROOT, FONTS_DIR)): Promise<VendoredFont[]> {
	const out: VendoredFont[] = [];
	for (const family of FONT_FAMILIES) {
		const [file] = await describeFiles(dir, [family.file]);
		if (!file) throw new Error(`${family.file} missing from ${FONTS_DIR}`);
		out.push({ ...family, ...file });
	}
	return out;
}
