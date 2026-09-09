// scripts/vendor-engine.ts — vendor Stockfish 18 (`@lichess-org/stockfish-web`) and the
// smallnet NNUE into `assets/engine/` (Task 10, §6.1–6.2).
//
// 1. Copies the files named by `ENGINE_FILES` (+ the AGPL `LICENSE`) from the installed npm
//    package into `assets/engine/`, and `stockfishWeb.d.ts` into `src/types/stockfish-web.d.ts`.
// 2. Downloads `LIMITS.nnueSmallName` from `URLS.nnueMirror` unless a verified copy already
//    exists. A net's file name is the first 12 hex digits of its SHA-256, which is checked
//    before the file is written (`verifyNnueHash`). The `full` nets are on-demand (Task 12)
//    and are deliberately not downloaded.
// 3. Writes `docs/third-party.md`: versions, the source offer and the SHA-256 of every file —
//    including the opening books in `assets/books/` (Task 15; built by
//    `scripts/build-club-book.py`, described here, never downloaded).
// 3. Writes `docs/third-party.md`: versions, the source offer and the SHA-256 of every file,
//    plus the vendored UI fonts section (Task 27; `FONT_FAMILIES`, `renderFontsSection`).
// 4. Task 34: vendors onnxruntime-web (`ORT_FILES` from the pinned npm package + the MIT text
//    from the onnxruntime repository at the same tag) into `assets/vendor/onnxruntime/`, checks
//    the exported ChessMimic bands in `assets/models/chessmimic/` against the registry
//    (`CHESSMIMIC_BAND_FILES`) and renders both notices (PolyForm Noncommercial 1.0.0 beside the
//    Stockfish AGPL notice; MIT for onnxruntime-web).
//
// Run: `bun run vendor:engine` (re-runnable; idempotent when nothing changed).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "..");

export const PACKAGE_NAME = "@lichess-org/stockfish-web";
const PACKAGE_DIR = path.join(ROOT, "node_modules", ...PACKAGE_NAME.split("/"));
const PACKAGE_REPO = "https://github.com/lichess-org/stockfish-web";
const STOCKFISH_REPO = "https://github.com/official-stockfish/Stockfish";
/** Upstream base of the `sf_18` targets (package README). */
const STOCKFISH_BASE_COMMIT = "cb3d4ee9b47d0c5aae855b12379378ea1439675c";
const STOCKFISH_TAG = "sf_18";

const LICENSE_FILE = "LICENSE";
const TYPES_FILE = "stockfishWeb.d.ts";
const TYPES_DEST = path.join(ROOT, "src", "types", "stockfish-web.d.ts");
const DOCS_DEST = path.join(ROOT, "docs", "third-party.md");

const NNUE_NAME_RE = /^nn-([0-9a-f]{12})\.nnue$/;
const HASH_PREFIX_LEN = 12;

export function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** The 12-hex-digit SHA-256 prefix encoded in a Stockfish net name, if well-formed. */
export function nnueHashPrefix(name: string): string | undefined {
	return NNUE_NAME_RE.exec(name)?.[1];
}

/** True when `data` is the net `name` claims to be (`sha256(data)[0:12] === <hash in name>`). */
export function verifyNnueHash(data: Uint8Array, name: string): boolean {
	const expected = nnueHashPrefix(name);
	return expected !== undefined && sha256Hex(data).slice(0, HASH_PREFIX_LEN) === expected;
}

interface BookRegistry {
	dir: string;
	gm2600: string;
	club: string;
}

interface ModelsRegistry {
	MODELS_DIR: string;
	CHESSMIMIC_FILES: {
		scalers: string;
		buckets: string;
		vocab: string;
		manifest: string;
		onnxSuffix: string;
	};
	CHESSMIMIC_BANDS: readonly string[];
	CHESSMIMIC_BAND_FILES: Readonly<
		Record<string, { bytes: number; sha256: string; bundled: boolean }>
	>;
	CHESSMIMIC_UPSTREAM: {
		name: string;
		repo: string;
		commit: string;
		license: string;
		licenseName: string;
		licenseUrl: string;
		copyright: string;
		site: string;
	};
	ORT_DIR: string;
	ORT_PACKAGE: string;
	ORT_VERSION: string;
	ORT_FILES: { module: string; loader: string; wasm: string; license: string };
	chessmimicBandBase: string;
	onnxruntimeRepo: string;
	onnxruntimeRaw: string;
}

interface EngineRegistry extends ModelsRegistry {
	BOOKS: BookRegistry;
	ENGINE_DIR: string;
	ENGINE_FILES: {
		smallnet: { js: string; wasm: string; relaxedJs: string; relaxedWasm: string; nnue: string };
		full: { js: string; wasm: string; nnue: readonly [string, string] };
	};
	nnueMirror: string;
	website: string;
}

/** Package files copied verbatim into `ENGINE_DIR` (everything but the nets). */
export function packageFiles(files: EngineRegistry["ENGINE_FILES"]): string[] {
	const { smallnet, full } = files;
	return [
		smallnet.js,
		smallnet.wasm,
		smallnet.relaxedJs,
		smallnet.relaxedWasm,
		full.js,
		full.wasm,
		LICENSE_FILE,
	];
}

/**
 * `limits.ts`/`urls.ts` read the bundler's `__SL_*` defines at module scope (the bundle and
 * `test/setup.ts` provide them), so a plain `bun` run installs placeholders before importing.
 */
async function loadRegistry(): Promise<EngineRegistry> {
	const g = globalThis as Record<string, unknown>;
	g.__SL_LICENSE_ENFORCE__ ??= false;
	g.__SL_LICENSE_URL__ ??= "";
	const [{ ENGINE_DIR, ENGINE_FILES }, { URLS }, { BOOKS }, models] = await Promise.all([
		import("../src/core/constants/engine-files"),
		import("../src/core/constants/urls"),
		import("../src/core/constants/books"),
		import("../src/core/constants/models"),
	]);
	return {
		BOOKS,
		ENGINE_DIR,
		ENGINE_FILES,
		nnueMirror: URLS.nnueMirror,
		website: URLS.website,
		MODELS_DIR: models.MODELS_DIR,
		CHESSMIMIC_FILES: models.CHESSMIMIC_FILES,
		CHESSMIMIC_BANDS: models.CHESSMIMIC_BANDS,
		CHESSMIMIC_BAND_FILES: models.CHESSMIMIC_BAND_FILES,
		CHESSMIMIC_UPSTREAM: models.CHESSMIMIC_UPSTREAM,
		ORT_DIR: models.ORT_DIR,
		ORT_PACKAGE: models.ORT_PACKAGE,
		ORT_VERSION: models.ORT_VERSION,
		ORT_FILES: models.ORT_FILES,
		chessmimicBandBase: URLS.chessmimicBandBase,
		onnxruntimeRepo: URLS.onnxruntimeRepo,
		onnxruntimeRaw: URLS.onnxruntimeRaw,
	};
}

async function packageVersion(): Promise<string> {
	const pkg = JSON.parse(await readFile(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
		version?: string;
	};
	if (!pkg.version) throw new Error(`${PACKAGE_NAME}: package.json has no version`);
	return pkg.version;
}

async function copyPackageFiles(names: string[], destDir: string): Promise<void> {
	for (const name of names) {
		const src = path.join(PACKAGE_DIR, name);
		if (!existsSync(src)) throw new Error(`${PACKAGE_NAME} does not ship ${name}`);
		await copyFile(src, path.join(destDir, name));
	}
	await copyFile(path.join(PACKAGE_DIR, TYPES_FILE), TYPES_DEST);
}

async function hasVerifiedNet(file: string, name: string): Promise<boolean> {
	if (!existsSync(file)) return false;
	return verifyNnueHash(new Uint8Array(await readFile(file)), name);
}

async function downloadNet(mirror: string, name: string, dest: string): Promise<void> {
	const url = mirror + name;
	console.log(`downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
	const data = new Uint8Array(await res.arrayBuffer());
	if (!verifyNnueHash(data, name))
		throw new Error(`${name}: sha256 ${sha256Hex(data).slice(0, HASH_PREFIX_LEN)} != name`);
	await writeFile(dest, data);
}

interface VendoredFile {
	name: string;
	bytes: number;
	sha256: string;
}

async function describe(dir: string, names: string[]): Promise<VendoredFile[]> {
	const out: VendoredFile[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		out.push({
			name,
			bytes: (await stat(file)).size,
			sha256: sha256Hex(new Uint8Array(await readFile(file))),
		});
	}
	return out;
}

/** `<book>.build.json` written by `scripts/build-club-book.py` next to each book. */
export interface BookManifest {
	book: string;
	script: string;
	inputs: string[];
	filters: {
		min_elo: number;
		max_elo: number | null;
		max_ply: number;
		min_count_requested: number;
		min_count: number;
		max_bytes: number;
		max_games: number;
		keep_bullet: boolean;
	};
	games_read: number;
	games_kept: number;
	positions: number;
	entries: number;
	bytes: number;
	sha256: string;
}

export interface ThirdPartyNotice {
	version: string;
	registry: EngineRegistry;
	engineFiles: VendoredFile[];
	typesFile: VendoredFile;
	/** The Polyglot books in `BOOKS.dir` (Task 15), each with its build manifest. */
	books: Array<{ file: VendoredFile; manifest: BookManifest }>;
	/** Task 27: the vendored UI fonts (`describeFonts()`); omitted → no fonts section. */
	fonts?: VendoredFont[];
	/** Task 34: the exported ChessMimic bands (`describeModels()`); omitted → no models section. */
	models?: ModelsNotice;
	/** Task 34: the vendored onnxruntime-web files (`vendorOnnxRuntime()`); omitted → no section. */
	onnxruntime?: VendoredFile[];
}

/** `models.json` as written by `tools/data/08_export_chessmimic.py`. */
export interface ModelsManifest {
	upstream: { repo: string; commit: string; license: string };
	export: {
		script: string;
		opset: number;
		precision: string;
		torch: string;
		onnx: string;
		onnxruntime: string;
	};
	bands: Record<
		string,
		{
			file: string;
			bytes: number;
			sha256: string;
			checkpoint: { path: string; lfsOid: string; bytes: number };
			fp32Bytes: number;
			weights: string;
			fixturePositions?: number;
			maxAbsProbDiffOnnxVsTorch?: number;
		}
	>;
}

export interface ModelsNotice {
	manifest: ModelsManifest;
	bands: VendoredFile[];
	sideFiles: VendoredFile[];
}

const LICHESS_DB = "https://database.lichess.org/";
const LICHESS_ELITE_DB = "https://database.nikonoel.fr/";

/** The literal `build-club-book.py` invocation recorded by a manifest. */
export function bookCommand(dir: string, m: BookManifest): string {
	const f = m.filters;
	const flags = [
		`--min-elo ${f.min_elo}`,
		...(f.max_elo === null ? [] : [`--max-elo ${f.max_elo}`]),
		...(f.max_ply === 30 ? [] : [`--max-ply ${f.max_ply}`]),
		`--min-count ${f.min_count_requested}`,
		`--max-bytes ${f.max_bytes}`,
		...(f.max_games ? [`--max-games ${f.max_games}`] : []),
		...(f.keep_bullet ? ["--keep-bullet"] : []),
		`--output ${dir}${m.book}`,
	];
	const inputs = m.inputs.map((i) => `--input ${i}`).join(" ");
	return `uv run --with chess --with zstandard ${m.script} ${inputs} ${flags.join(" ")}`;
}

function describeFilter(m: BookManifest): string {
	const f = m.filters;
	const elo = f.max_elo === null ? `≥ ${f.min_elo}` : `${f.min_elo}–${f.max_elo}`;
	const bullet = f.keep_bullet ? "" : ", no bullet";
	return `both players rated ${elo}${bullet}, first ${f.max_ply} plies, ≥ ${f.min_count} games per move`;
}

/** Load every `<book>.build.json` for the registry's books. */
export async function readBookManifests(
	dir: string,
	names: string[]
): Promise<Array<{ file: VendoredFile; manifest: BookManifest }>> {
	const files = await describe(dir, names);
	const out: Array<{ file: VendoredFile; manifest: BookManifest }> = [];
	for (const file of files) {
		const manifestPath = path.join(dir, `${file.name}.build.json`);
		if (!existsSync(manifestPath))
			throw new Error(`${file.name}: missing ${path.basename(manifestPath)} (run build-club-book.py)`);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BookManifest;
		if (manifest.sha256 !== file.sha256)
			throw new Error(`${file.name}: manifest sha256 ${manifest.sha256} != file ${file.sha256}`);
		out.push({ file, manifest });
	}
	return out;
}

export function renderThirdParty(n: ThirdPartyNotice): string {
	const { ENGINE_DIR, ENGINE_FILES, nnueMirror, website } = n.registry;
	const [big, small] = ENGINE_FILES.full.nnue;
	const row = (f: VendoredFile) =>
		`| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} | \`${f.sha256}\` |`;
	return `# Third-party components

<!-- Generated by \`bun run vendor:engine\` (scripts/vendor-engine.ts); do not edit by hand. -->

## Stockfish 18 — \`${PACKAGE_NAME}\` ${n.version}

sliced.gg bundles a WebAssembly build of the Stockfish chess engine under \`${ENGINE_DIR}\` and
drives it over UCI from an offscreen document. The engine is a separate program: sliced.gg's own
code is not derived from Stockfish and talks to it only through the package's public API
(\`uci\`, \`setNnueBuffer\`, \`listen\`, \`onError\`).

| Component | Version | License | Source |
|---|---|---|---|
| \`${PACKAGE_NAME}\` (build scripts, patches, Emscripten glue) | ${n.version} | AGPL-3.0-or-later | ${PACKAGE_REPO} |
| Stockfish | 18 (tag \`${STOCKFISH_TAG}\`, base \`${STOCKFISH_BASE_COMMIT.slice(0, 8)}\`) | GPL-3.0-or-later | ${STOCKFISH_REPO} |
| NNUE network \`${ENGINE_FILES.smallnet.nnue}\` (smallnet weights) | — | distributed by the Stockfish project | ${nnueMirror}${ENGINE_FILES.smallnet.nnue} |

Targets vendored: \`sf_18_smallnet\` (Stockfish 18 with the sscg13/threat-small patch, plus the
\`_relaxed-simd\` variant) and \`sf_18\` (the dual-net full build). The full build's networks
\`${big}\` (big) and \`${small}\` (small) are **not** bundled; they are downloaded on demand from
\`${nnueMirror}\` and verified before use.

### Source offer

The files in \`${ENGINE_DIR}\` are unmodified copies of the npm package's published files. The
complete corresponding source is:

- the build scripts, patches and glue at ${PACKAGE_REPO} (npm version ${n.version});
- the Stockfish sources at ${STOCKFISH_REPO}/commit/${STOCKFISH_BASE_COMMIT} (tag \`${STOCKFISH_TAG}\`).

The full AGPL-3.0 text ships with the extension as \`${ENGINE_DIR}${LICENSE_FILE}\`. On request,
the sliced.gg maintainers will also provide these sources on a durable medium, as required by
GPL-3.0 §6 / AGPL-3.0 §6; contact details are at ${website}.

### Network integrity

A Stockfish net is named \`nn-<first 12 hex digits of its SHA-256>.nnue\`. The bundled net was
verified against its name when vendored, and the on-demand nets are verified the same way after
download.

### Vendored files (\`${ENGINE_DIR}\`)

| File | Bytes | SHA-256 |
|---|---|---|
${n.engineFiles.map(row).join("\n")}

Types only (not shipped): \`src/types/stockfish-web.d.ts\` copied from the package's
\`${TYPES_FILE}\` (${n.typesFile.bytes} bytes, SHA-256 \`${n.typesFile.sha256}\`).
${n.models ? `\n${renderModelsSection(n.registry, n.models)}\n` : ""}${n.onnxruntime ? `\n${renderOnnxRuntimeSection(n.registry, n.onnxruntime)}\n` : ""}
## Opening books — \`${n.registry.BOOKS.dir}\`

Both Polyglot books are generated by \`scripts/build-club-book.py\` from games in the Lichess open
database (${LICHESS_DB}), which Lichess releases under the Creative Commons CC0 1.0
public-domain dedication; \`lichess_elite_*.zip\` inputs are the Lichess Elite Database
(${LICHESS_ELITE_DB}), a subset of that database (2400+ vs 2200+, no bullet). Nothing under
\`${n.registry.BOOKS.dir}\` is copied from a third-party book file. Each book ships with a
\`<book>.build.json\` manifest; the rows below are rendered from those manifests.

| File | Inputs | Filter | Games kept / read | Entries |
|---|---|---|---|---|
${n.books
	.map(
		({ manifest: m }) =>
			`| \`${m.book}\` | ${m.inputs.map((i) => `\`${i}\``).join(", ")} | ${describeFilter(m)} | ${m.games_kept.toLocaleString("en-US")} / ${m.games_read.toLocaleString("en-US")} | ${m.entries.toLocaleString("en-US")} |`
	)
	.join("\n")}

Exact invocations (inputs are the unmodified downloads):

${n.books.map(({ manifest: m }) => `    ${bookCommand(n.registry.BOOKS.dir, m)}`).join("\n\n")}

The Polyglot \`Random64\` table in \`src/core/strength/book/random64.ts\` is transcribed from
Michel Van den Bergh's format description (http://hgm.nubati.net/book_format.html), which states
the table is not subject to copyright and releases its sample code into the public domain.

Note: the \`gm2600\` registry key follows the plan's naming; the file is **not** the SCID/Pascal
Georges \`gm2600.bin\`, whose licence forbids reuse without the author's permission.

| File | Bytes | SHA-256 |
|---|---|---|
${n.books.map(({ file }) => row(file)).join("\n")}
${n.fonts ? `\n${renderFontsSection(n.fonts)}` : ""}`;
}

// ── Task 34: ChessMimic bands (`assets/models/chessmimic/`) and onnxruntime-web ─────────────

const ORT_PACKAGE_DIR = (registry: ModelsRegistry): string =>
	path.join(ROOT, "node_modules", registry.ORT_PACKAGE);

/** Sizes + hashes of the exported bands and side files, checked against the registry. */
export async function describeModels(registry: ModelsRegistry): Promise<ModelsNotice> {
	const dir = path.join(ROOT, registry.MODELS_DIR);
	const manifestPath = path.join(dir, registry.CHESSMIMIC_FILES.manifest);
	if (!existsSync(manifestPath))
		throw new Error(`${registry.CHESSMIMIC_FILES.manifest} missing (run 08_export_chessmimic.py)`);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ModelsManifest;
	if (manifest.upstream.commit !== registry.CHESSMIMIC_UPSTREAM.commit)
		throw new Error(
			`models.json commit ${manifest.upstream.commit} != registry ${registry.CHESSMIMIC_UPSTREAM.commit}`
		);
	const bandNames = [...registry.CHESSMIMIC_BANDS].filter(
		(b) => registry.CHESSMIMIC_BAND_FILES[b]?.bundled
	);
	const bands = await describe(
		dir,
		bandNames.map((b) => `${b}${registry.CHESSMIMIC_FILES.onnxSuffix}`)
	);
	for (const band of bandNames) {
		const reg = registry.CHESSMIMIC_BAND_FILES[band];
		const man = manifest.bands[band];
		const file = bands.find((f) => f.name === `${band}${registry.CHESSMIMIC_FILES.onnxSuffix}`);
		if (!reg || !man || !file) throw new Error(`${band}: missing in registry, manifest or on disk`);
		if (reg.sha256 !== file.sha256 || reg.bytes !== file.bytes)
			throw new Error(`${band}: registry ${reg.sha256} != file ${file.sha256} (update models.ts)`);
		if (man.sha256 !== file.sha256)
			throw new Error(`${band}: manifest ${man.sha256} != file ${file.sha256}`);
	}
	const f = registry.CHESSMIMIC_FILES;
	const sideFiles = await describe(dir, [f.scalers, f.buckets, f.vocab, f.manifest]);
	return { manifest, bands, sideFiles };
}

/** Copy `ORT_FILES` from the pinned package and fetch the MIT text from the tagged repository. */
export async function vendorOnnxRuntime(registry: ModelsRegistry): Promise<VendoredFile[]> {
	const pkgDir = ORT_PACKAGE_DIR(registry);
	const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
		version?: string;
	};
	if (pkg.version !== registry.ORT_VERSION)
		throw new Error(
			`${registry.ORT_PACKAGE}@${pkg.version} installed; registry pins ${registry.ORT_VERSION}`
		);
	const destDir = path.join(ROOT, registry.ORT_DIR);
	await mkdir(destDir, { recursive: true });
	const names = [registry.ORT_FILES.module, registry.ORT_FILES.loader, registry.ORT_FILES.wasm];
	for (const name of names) {
		const src = path.join(pkgDir, "dist", name);
		if (!existsSync(src)) throw new Error(`${registry.ORT_PACKAGE} does not ship dist/${name}`);
		await copyFile(src, path.join(destDir, name));
	}
	const licenseDest = path.join(destDir, registry.ORT_FILES.license);
	if (!existsSync(licenseDest) || !(await readFile(licenseDest, "utf8")).includes("MIT License")) {
		const url = `${registry.onnxruntimeRaw}v${registry.ORT_VERSION}/${registry.ORT_FILES.license}`;
		console.log(`downloading ${url}`);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
		const text = await res.text();
		if (!text.includes("MIT License")) throw new Error(`${url} is not the MIT licence text`);
		await writeFile(licenseDest, text);
	}
	console.log(
		`vendored ${names.length} files from ${registry.ORT_PACKAGE}@${registry.ORT_VERSION} to ${registry.ORT_DIR}`
	);
	return describe(destDir, [...names, registry.ORT_FILES.license]);
}

export function renderModelsSection(registry: ModelsRegistry, m: ModelsNotice): string {
	const up = registry.CHESSMIMIC_UPSTREAM;
	const row = (f: VendoredFile) =>
		`| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} | \`${f.sha256}\` |`;
	const bandRow = (band: string) => {
		const b = m.manifest.bands[band];
		if (!b) return "";
		const diff =
			b.maxAbsProbDiffOnnxVsTorch === undefined ? "—" : b.maxAbsProbDiffOnnxVsTorch.toExponential(2);
		return `| ${band.replace("_", "–")} | \`${b.file}\` | \`${b.checkpoint.lfsOid.slice(0, 12)}\` | ${b.bytes.toLocaleString("en-US")} | ${diff} |`;
	};
	return `## ChessMimic timing model — \`${registry.MODELS_DIR}\`

sliced.gg's human move-timing head is the clock model of **${up.name}** (Thomas Johnson, 2026;
the engine behind ${up.site}), exported from the checkpoints published at ${up.repo} (commit
\`${up.commit}\`). Required Notice: ${up.copyright}. The source code **and the trained weights** are licensed
under the **${up.licenseName}** (${up.licenseUrl}; SPDX \`${up.license}\`) — the weights may
only be used for non-commercial purposes, which is what sliced.gg is. The ONNX files below are
derived works of those weights (same parameters, stored as float16, opset ${m.manifest.export.opset}) and are
distributed under the same licence; the PolyForm text is reproduced in the upstream \`LICENSE\`.
The searchless_chess FEN tokeniser ChessMimic builds on is Apache-2.0 (google-deepmind); the
extension's TypeScript transcription of it lives in \`src/core/timing/chessmimic-tokeniser.ts\`.

Export: \`${m.manifest.export.script}\` (torch ${m.manifest.export.torch}, onnx ${m.manifest.export.onnx},
onnxruntime ${m.manifest.export.onnxruntime}; details, latency and the reference fixture in \`docs/models.md\`).

| Band (Elo) | File | Checkpoint (LFS oid) | Bytes | max \\|Δprob\\| vs torch fp32 |
|---|---|---|---|---|
${[...registry.CHESSMIMIC_BANDS].map(bandRow).filter(Boolean).join("\n")}

Bands that are registered but not bundled would download from \`${registry.chessmimicBandBase}\` and
are verified against the SHA-256 in \`src/core/constants/models.ts\` before use.

| File | Bytes | SHA-256 |
|---|---|---|
${[...m.bands, ...m.sideFiles].map(row).join("\n")}`;
}

export function renderOnnxRuntimeSection(
	registry: ModelsRegistry,
	files: readonly VendoredFile[]
): string {
	const row = (f: VendoredFile) =>
		`| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} | \`${f.sha256}\` |`;
	return `## ONNX Runtime Web — \`${registry.ORT_PACKAGE}\` ${registry.ORT_VERSION}

The timing model runs through Microsoft's ONNX Runtime (${registry.onnxruntimeRepo}), MIT
licensed (Copyright (c) Microsoft Corporation); the licence text ships as
\`${registry.ORT_DIR}${registry.ORT_FILES.license}\`. The files under \`${registry.ORT_DIR}\` are unmodified copies of
the npm package's \`dist/\` files (WebAssembly backend, SIMD + threads; loaded from the extension
package, never from a CDN).

| File | Bytes | SHA-256 |
|---|---|---|
${files.map(row).join("\n")}`;
}

// ── Task 27: vendored UI fonts (`assets/fonts/`) ────────────────────────────────────────────
// Kept as a separate, self-contained block so other lanes' additions to this file merge cleanly.

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
		const [file] = await describe(dir, [family.file]);
		if (!file) throw new Error(`${family.file} missing from ${FONTS_DIR}`);
		out.push({ ...family, ...file });
	}
	return out;
}

export function renderFontsSection(fonts: readonly VendoredFont[]): string {
	const total = fonts.reduce((n, f) => n + f.bytes, 0);
	const row = (f: VendoredFont) =>
		`| ${f.family} | \`${f.file}\` | ${f.axes} | ${f.bytes.toLocaleString("en-US")} | \`${f.sha256}\` |`;
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

Total ${total.toLocaleString("en-US")} bytes (budget ${FONT_BUDGET_BYTES.toLocaleString("en-US")} = 260 KB).

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

export async function vendorEngine(): Promise<void> {
	const registry = await loadRegistry();
	const { ENGINE_DIR, ENGINE_FILES, nnueMirror } = registry;
	const destDir = path.join(ROOT, ENGINE_DIR);
	await mkdir(destDir, { recursive: true });

	const version = await packageVersion();
	const copied = packageFiles(ENGINE_FILES);
	await copyPackageFiles(copied, destDir);
	console.log(`copied ${copied.length} files from ${PACKAGE_NAME}@${version} to ${ENGINE_DIR}`);

	const net = ENGINE_FILES.smallnet.nnue;
	const netFile = path.join(destDir, net);
	if (await hasVerifiedNet(netFile, net)) console.log(`${net}: present and verified`);
	else await downloadNet(nnueMirror, net, netFile);

	const engineFiles = await describe(destDir, [...copied, net]);
	const [typesFile] = await describe(path.dirname(TYPES_DEST), [path.basename(TYPES_DEST)]);
	if (!typesFile) throw new Error("types file missing after copy");
	const { BOOKS } = registry;
	const books = await readBookManifests(path.join(ROOT, BOOKS.dir), [BOOKS.gm2600, BOOKS.club]);
	const fonts = await describeFonts();
	const onnxruntime = await vendorOnnxRuntime(registry);
	const models = await describeModels(registry);
	await writeFile(
		DOCS_DEST,
		renderThirdParty({ version, registry, engineFiles, typesFile, books, fonts, models, onnxruntime })
	);
	console.log(`wrote ${path.relative(ROOT, DOCS_DEST)}`);
}

if (import.meta.main) await vendorEngine();
