// scripts/vendor-engine/notice/fonts.ts — the UI fonts section (Task 27, OFL 1.1).

import {
	FONT_BUDGET_BYTES,
	FONT_UNICODE_RANGE_CSS,
	FONT_UNICODES,
	FONTS_DIR,
	type VendoredFont,
} from "../fonts";
import { count } from "./table";

export function renderFontsSection(fonts: readonly VendoredFont[]): string {
	const total = fonts.reduce((n, f) => n + f.bytes, 0);
	const row = (f: VendoredFont) =>
		`| ${f.family} | \`${f.file}\` | ${f.axes} | ${count(f.bytes)} | \`${f.sha256}\` |`;
	const provenance = (f: VendoredFont) =>
		`- **${f.family}** — ${f.source}; ${f.version}. ${f.copyright}. Licence text: \`${FONTS_DIR}${f.licenseFile}\`.`;
	return `## UI fonts — \`${FONTS_DIR}\`

The panel's type (Lattice \`tokens.type.family\`) is three open-source families, all under the
SIL Open Font License 1.1 (the OFL text ships next to each file). Each is a variable woff2,
instanced to the weights the design system uses and subset to Latin plus the panel's symbols
with \`fonttools\` (\`pyftsubset\` / \`varLib.instancer\`); the fonts are not modified otherwise.
Subset builds are "Modified Versions" under the OFL, which may be bundled and redistributed;
OFL §3 forbids using a Reserved Font Name for a Modified Version, and none of these families
declares one, which is why the subsets may keep their original family names.

| Family | File | Axes kept | Bytes | SHA-256 |
|---|---|---|---|---|
${fonts.map(row).join("\n")}

Total ${count(total)} bytes (budget ${count(FONT_BUDGET_BYTES)} = 260 KB).

Each \`@font-face\` declares \`unicode-range: ${FONT_UNICODE_RANGE_CSS}\`.

${fonts.map(provenance).join("\n")}

Subset recipe (reproducible; run from a scratch venv with \`fonttools\` + \`brotli\`):

\`\`\`
python -m fontTools.varLib.instancer <upstream>.ttf "wght=400:600" [opsz/wdth as per the table] -o <family>-var.ttf
pyftsubset <family>-var.ttf --unicodes="${FONT_UNICODES}" \\
  --layout-features="kern,liga,calt,tnum,lnum,pnum,onum,frac,ccmp,locl,mark,mkmk,ss01-ss10,zero,case,cpsp,salt,sups,subs,numr,dnom" \\
  --flavor=woff2 --no-hinting --desubroutinize --name-IDs='*' --name-legacy --notdef-outline --drop-tables+=DSIG \\
  --output-file=${FONTS_DIR}<Family>-Variable.woff2
\`\`\`
`;
}
