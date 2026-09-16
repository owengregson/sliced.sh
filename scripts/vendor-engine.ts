// scripts/vendor-engine.ts — vendor Stockfish 19 (`@lichess-org/stockfish-web`) and the
// all NNUE variants into `assets/engine/` (Task 10, §6.1–6.2).
//
// 1. Copies the files named by `ENGINE_FILES` (+ the AGPL `LICENSE`) from the installed npm
//    package into `assets/engine/`, and `stockfishWeb.d.ts` into `src/types/stockfish-web.d.ts`.
// 2. Downloads registered nets from `URLS.nnueMirror` unless verified sources already exist.
//    A net's file name is its SHA-256 prefix, checked before writing. The large net is stored
//    as deterministic gzip to fit the Git host's file limit; build emits verified raw bytes.
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
// 5. Maia-3 (2026-09-11): checks the exported policy models in `assets/models/maia3/` against
//    the registry (`MAIA_MODEL_FILES`; the 79M file is joined from its `.part<i>` slices first)
//    and renders the AGPL-3.0-or-later notice with the per-size Hugging Face provenance and the
//    source offer (`renderMaiaSection`).
//
// Run: `bun run vendor:engine` (re-runnable; idempotent when nothing changed).

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { maiaSourceNames, readMaiaSource } from "./maia-assets";
import {
	encodeNnueSource,
	type NnueSource,
	readNnueSource,
	sha256Hex,
	verifyNnueHash,
} from "./nnue-assets";

export { nnueHashPrefix, sha256Hex, verifyNnueHash } from "./nnue-assets";

export const ROOT = path.resolve(import.meta.dir, "..");

export const PACKAGE_NAME = "@lichess-org/stockfish-web";
const PACKAGE_DIR = path.join(ROOT, "node_modules", ...PACKAGE_NAME.split("/"));
const PACKAGE_REPO = "https://github.com/lichess-org/stockfish-web";
const STOCKFISH_REPO = "https://github.com/official-stockfish/Stockfish";
/**
 * Upstream base of the `sf_19` targets (package README). These two values are the written offer of
 * corresponding source (GPL-3.0 §6 / AGPL-3.0 §6) rendered into `docs/third-party.md`: no check
 * verifies them against the installed package, so they must be updated by hand with the version.
 */
const STOCKFISH_BASE_COMMIT = "edb0d9db6731067ec50ce619ff372b463bc4dd5d";
const STOCKFISH_TAG = "sf_19";

const LICENSE_FILE = "LICENSE";
const TYPES_FILE = "stockfishWeb.d.ts";
const TYPES_DEST = path.join(ROOT, "src", "types", "stockfish-web.d.ts");
const DOCS_DEST = path.join(ROOT, "docs", "third-party.md");

const HASH_PREFIX_LEN = 12;

interface BookRegistry {
	dir: string;
	gm2600: string;
	club: string;
	theory: string;
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

/** `src/core/constants/maia.ts`, the parts the notice needs. */
interface MaiaRegistry {
	MAIA_DIR: string;
	MAIA_SIZES: readonly string[];
	MAIA_MODEL_FILES: Readonly<
		Record<
			string,
			{
				file: string;
				bytes: number;
				sha256: string;
				parts: number;
				upstream: {
					repo: string;
					revision: string;
					checkpoint: string;
					bytes: number;
					sha256: string;
				};
				params: number;
				dModel: number;
				heads: number;
			}
		>
	>;
	MAIA_FILES: { manifest: string; license: string; partSuffix: string; partBytes: number };
	MAIA_UPSTREAM: {
		name: string;
		repo: string;
		license: string;
		licenseName: string;
		licenseUrl: string;
		copyright: string;
		paper: string;
		paperTitle: string;
		hub: string;
	};
}

interface EngineRegistry extends ModelsRegistry {
	maia: MaiaRegistry;
	BOOKS: BookRegistry;
	ENGINE_DIR: string;
	ENGINE_NNUE_SOURCES: readonly NnueSource[];
	ENGINE_FILES: {
		smallnet: { js: string; wasm: string; nnue: string };
		/** One net since Stockfish 19 retired the full build's secondary network; a list either way. */
		full: { js: string; wasm: string; nnue: readonly string[] };
	};
	nnueMirror: string;
	website: string;
}

/**
 * Package files copied verbatim into `ENGINE_DIR` (everything but the nets): the relaxed-SIMD
 * programs only (2026-09-13; `ENGINE_PROGRAM_FILES` lists the same four) and the AGPL text.
 */
export function packageFiles(files: EngineRegistry["ENGINE_FILES"]): string[] {
	const { smallnet, full } = files;
	return [smallnet.js, smallnet.wasm, full.js, full.wasm, LICENSE_FILE];
}

/**
 * Files in `ENGINE_DIR` that neither the registry's programs, its net sources nor the licence
 * account for — a build that stopped shipping (the plain-SIMD `sf_19*.js/.wasm`), a superseded one
 * (every `sf_18*` program and net after the 2026-09-15 move to Stockfish 19) or
 * a stray download. They never reach the package (`copyBundledAssets` copies by allowlist), but
 * they sit in the repository; the vendor step names them so they get deleted.
 */
export function staleEngineFiles(
	onDisk: readonly string[],
	files: EngineRegistry["ENGINE_FILES"],
	sources: readonly NnueSource[]
): string[] {
	const keep = new Set([...packageFiles(files), ...sources.map((spec) => spec.source)]);
	return onDisk.filter((name) => !keep.has(name) && !name.startsWith(".")).sort();
}

/**
 * `limits.ts`/`urls.ts` read the bundler's `__SL_*` defines at module scope (the bundle and
 * `test/setup.ts` provide them), so a plain `bun` run installs placeholders before importing.
 */
async function loadRegistry(): Promise<EngineRegistry> {
	const g = globalThis as Record<string, unknown>;
	g.__SL_LICENSE_ENFORCE__ ??= false;
	g.__SL_LICENSE_URL__ ??= "";
	const [{ ENGINE_DIR, ENGINE_FILES, ENGINE_NNUE_SOURCES }, { URLS }, { BOOKS }, models, maia] =
		await Promise.all([
			import("../src/core/constants/engine-files"),
			import("../src/core/constants/urls"),
			import("../src/core/constants/books"),
			import("../src/core/constants/models"),
			import("../src/core/constants/maia"),
		]);
	return {
		maia: {
			MAIA_DIR: maia.MAIA_DIR,
			MAIA_SIZES: maia.MAIA_SIZES,
			MAIA_MODEL_FILES: maia.MAIA_MODEL_FILES,
			MAIA_FILES: maia.MAIA_FILES,
			MAIA_UPSTREAM: maia.MAIA_UPSTREAM,
		},
		BOOKS,
		ENGINE_DIR,
		ENGINE_FILES,
		ENGINE_NNUE_SOURCES,
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

async function hasVerifiedNet(dir: string, spec: NnueSource): Promise<boolean> {
	try {
		await readNnueSource(dir, spec);
		return true;
	} catch {
		return false;
	}
}

async function downloadNet(mirror: string, spec: NnueSource, destDir: string): Promise<void> {
	const { name, source } = spec;
	const url = mirror + name;
	console.log(`downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
	const data = new Uint8Array(await res.arrayBuffer());
	if (!verifyNnueHash(data, name))
		throw new Error(`${name}: sha256 ${sha256Hex(data).slice(0, HASH_PREFIX_LEN)} != name`);
	await writeFile(path.join(destDir, source), await encodeNnueSource(data, spec));
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

/** `<book>.build.json` written by `scripts/build-club-book.py` next to each game book. */
export interface BookManifest {
	book: string;
	script: string;
	inputs: string[];
	/** SHA-256 of every input (2026-09-15 on). */
	input_sha256?: Record<string, string>;
	filters: {
		min_elo: number;
		max_elo: number | null;
		max_ply: number;
		min_count_requested: number;
		min_count: number;
		/** Games reaching the position (2026-09-15 on; absent = 0). */
		min_position?: number;
		/** Share of the position's games (2026-09-15 on; absent = 0). */
		min_share?: number;
		max_bytes: number;
		max_games: number;
		keep_bullet: boolean;
		/** Games without both ratings kept (2026-09-15 on; absent = false). */
		allow_unrated?: boolean;
	};
	games_read: number;
	games_kept: number;
	positions: number;
	entries: number;
	bytes: number;
	sha256: string;
}

/** `theory.bin.build.json` written by `scripts/build-theory-book.py`. */
export interface TheoryBookManifest {
	book: string;
	kind: "theory";
	script: string;
	source: string;
	inputs: string[];
	input_sha256: Record<string, string>;
	lines: number;
	skipped_lines: number;
	max_plies: number;
	positions: number;
	entries: number;
	bytes: number;
	sha256: string;
}

export interface ThirdPartyNotice {
	version: string;
	registry: EngineRegistry;
	engineFiles: VendoredFile[];
	/** Decoded networks shipped by build, including any compressed repository source. */
	networks: VendoredFile[];
	typesFile: VendoredFile;
	/** The Polyglot game books in `BOOKS.dir` (Task 15), each with its build manifest. */
	books: Array<{ file: VendoredFile; manifest: BookManifest }>;
	/** The named-opening theory book (2026-09-15); omitted → no theory row. */
	theoryBook?: { file: VendoredFile; manifest: TheoryBookManifest };
	/** Task 27: the vendored UI fonts (`describeFonts()`); omitted → no fonts section. */
	fonts?: VendoredFont[];
	/** Task 34: the exported ChessMimic bands (`describeModels()`); omitted → no models section. */
	models?: ModelsNotice;
	/** Task 34: the vendored onnxruntime-web files (`vendorOnnxRuntime()`); omitted → no section. */
	onnxruntime?: VendoredFile[];
	/** Maia-3: the exported policy models (`describeMaia()`); omitted → no section. */
	maia?: MaiaNotice;
}

/** `models.json` as written by `tools/data/09_export_maia3.py`. */
export interface MaiaManifest {
	upstream: { name: string; repo: string; commit: string; license: string };
	export: {
		script: string;
		opset: number;
		precision: string;
		torch: string;
		onnx: string;
		onnxruntime: string;
	};
	split: { partSuffix: string; partBytes: number };
	models: Record<
		string,
		{
			file: string;
			bytes: number;
			sha256: string;
			parts: number;
			params: number;
			upstream: { repo: string; revision: string; checkpoint: string; bytes: number; sha256: string };
			fixturePositions?: number;
			maxAbsProbDiffOnnxVsTorch?: number;
		}
	>;
}

export interface MaiaNotice {
	manifest: MaiaManifest;
	/** The whole files as the build ships them (joined from parts where the registry says so). */
	models: VendoredFile[];
	/** What the repository actually stores: whole files, or the `.part<i>` slices. */
	sources: VendoredFile[];
	sideFiles: VendoredFile[];
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
		...(f.min_position ? [`--min-position ${f.min_position}`] : []),
		...(f.min_share ? [`--min-share ${f.min_share}`] : []),
		`--max-bytes ${f.max_bytes}`,
		...(f.max_games ? [`--max-games ${f.max_games}`] : []),
		...(f.keep_bullet ? ["--keep-bullet"] : []),
		...(f.allow_unrated ? ["--allow-unrated"] : []),
		`--output ${dir}${m.book}`,
	];
	const inputs = m.inputs.map((i) => `--input ${i}`).join(" ");
	const numpy = m.input_sha256 ? " --with numpy" : "";
	return `uv run --with chess --with zstandard${numpy} ${m.script} ${inputs} ${flags.join(" ")}`;
}

/** The literal `build-theory-book.py` invocation recorded by a theory manifest. */
export function theoryBookCommand(dir: string, m: TheoryBookManifest): string {
	const inputs = m.inputs.map((i) => `--input ${i}`).join(" ");
	return `uv run --with chess ${m.script} ${inputs} --output ${dir}${m.book}`;
}

function describeFilter(m: BookManifest): string {
	const f = m.filters;
	const elo = f.max_elo === null ? `≥ ${f.min_elo}` : `${f.min_elo}–${f.max_elo}`;
	const unrated = f.allow_unrated ? " (or unrated)" : "";
	const bullet = f.keep_bullet ? "" : ", no bullet";
	const position = f.min_position ? `, position reached ≥ ${f.min_position} times` : "";
	const share = f.min_share ? `, ≥ ${f.min_share * 100} % of the position's games` : "";
	return `both players rated ${elo}${unrated}${bullet}, first ${f.max_ply} plies, ≥ ${f.min_count} games per move${position}${share}`;
}

/** Load every `<book>.build.json` for the registry's books. */
export async function readBookManifests<M extends { sha256: string } = BookManifest>(
	dir: string,
	names: string[]
): Promise<Array<{ file: VendoredFile; manifest: M }>> {
	const files = await describe(dir, names);
	const out: Array<{ file: VendoredFile; manifest: M }> = [];
	for (const file of files) {
		const manifestPath = path.join(dir, `${file.name}.build.json`);
		if (!existsSync(manifestPath))
			throw new Error(`${file.name}: missing ${path.basename(manifestPath)} (run its build script)`);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as M;
		if (manifest.sha256 !== file.sha256)
			throw new Error(`${file.name}: manifest sha256 ${manifest.sha256} != file ${file.sha256}`);
		out.push({ file, manifest });
	}
	return out;
}

export function renderThirdParty(n: ThirdPartyNotice): string {
	const { ENGINE_DIR, ENGINE_FILES, nnueMirror, website } = n.registry;
	const fullNets = ENGINE_FILES.full.nnue;
	// `ENGINE_NNUE_SOURCES` gzips exactly the first full net, so that is the one the prose names.
	const [big] = fullNets;
	const row = (f: VendoredFile) =>
		`| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} | \`${f.sha256}\` |`;
	return `# Third-party components

<!-- Generated by \`bun run vendor:engine\` (scripts/vendor-engine.ts); do not edit by hand. -->

## Stockfish 19 — \`${PACKAGE_NAME}\` ${n.version}

sliced.sh bundles a WebAssembly build of the Stockfish chess engine under \`${ENGINE_DIR}\` and
drives it over UCI from an offscreen document. The engine is a separate program: sliced.sh's own
code is not derived from Stockfish and talks to it only through the package's public API
(\`uci\`, \`setNnueBuffer\`, \`listen\`, \`onError\`).

| Component | Version | License | Source |
|---|---|---|---|
| \`${PACKAGE_NAME}\` (build scripts, patches, Emscripten glue) | ${n.version} | AGPL-3.0-or-later | ${PACKAGE_REPO} |
| Stockfish | 19 (tag \`${STOCKFISH_TAG}\`, base \`${STOCKFISH_BASE_COMMIT.slice(0, 8)}\`) | GPL-3.0-or-later | ${STOCKFISH_REPO} |
| NNUE network \`${ENGINE_FILES.smallnet.nnue}\` (smallnet weights) | — | distributed by the Stockfish project | ${nnueMirror}${ENGINE_FILES.smallnet.nnue} |
${fullNets.map((name) => `| NNUE network \`${name}\` (full-build weights) | — | distributed by the Stockfish project | ${nnueMirror}${name} |`).join("\n")}

Targets vendored: \`sf_19_smallnet_relaxed-simd\` (Stockfish 19 with the sscg13/size-optimize-nnue
patch) and \`sf_19_relaxed-simd\` (the full build). Only the relaxed-SIMD variants ship:
relaxed SIMD has been in Chrome since 114 and the manifest's \`minimum_chrome_version\` is 128,
so the package's plain-SIMD \`sf_19\` / \`sf_19_smallnet\` programs are not vendored (2026-09-13).
Stockfish 19 retired the secondary network that sat inside the full build, so that build now loads
a single network, \`${big}\`, bundled alongside the smallnet's own. Switching to full
strength loads installed extension bytes without downloading networks. The repository stores
the full net as \`${big}.gz\` using deterministic gzip (level 9, no timestamp or filename) to keep
the checked-in file small. Build verifies and expands it to \`${big}\` and excludes the
compressed source from the extension; runtime does not decompress it.

### Source offer

Engine programs in \`${ENGINE_DIR}\` are unmodified copies of the npm package's published files;
network bytes come from the Stockfish project's mirror above. The complete corresponding source is:

- the build scripts, patches and glue at ${PACKAGE_REPO} (npm version ${n.version});
- the Stockfish sources at ${STOCKFISH_REPO}/commit/${STOCKFISH_BASE_COMMIT} (tag \`${STOCKFISH_TAG}\`).

The full AGPL-3.0 text ships with the extension as \`${ENGINE_DIR}${LICENSE_FILE}\`. On request,
the sliced.sh maintainers will also provide these sources on a durable medium, as required by
GPL-3.0 §6 / AGPL-3.0 §6; contact details are at ${website}. The same written offer covers the
corresponding source of every other GPL/AGPL component in this document — the Maia-3 models in
their own section below included.

### Network integrity

A Stockfish net is named \`nn-<first 12 hex digits of its SHA-256>.nnue\`. All decoded network bytes
are verified against their names both when vendored and when built. Cached or downloaded fallback
copies for older installations are verified before use. Build never needs a network connection
when the checked-in sources are present.

### Networks shipped in the extension (raw bytes)

| File | Bytes | SHA-256 |
|---|---|---|
${n.networks.map(row).join("\n")}

### Vendored files (\`${ENGINE_DIR}\`)

| File | Bytes | SHA-256 |
|---|---|---|
${n.engineFiles.map(row).join("\n")}

Types only (not shipped): \`src/types/stockfish-web.d.ts\` copied from the package's
\`${TYPES_FILE}\` (${n.typesFile.bytes} bytes, SHA-256 \`${n.typesFile.sha256}\`).
${n.models ? `\n${renderModelsSection(n.registry, n.models)}\n` : ""}${n.maia ? `\n${renderMaiaSection(n.registry.maia, n.maia, website)}\n` : ""}${n.onnxruntime ? `\n${renderOnnxRuntimeSection(n.registry, n.onnxruntime)}\n` : ""}
## Opening books — \`${n.registry.BOOKS.dir}\`

The game books are generated by \`scripts/build-club-book.py\` from games in the Lichess open
database (${LICHESS_DB} — rated games, and OTB broadcasts as \`lichess_db_broadcast_*\`), which
Lichess releases under the Creative Commons CC0 1.0 public-domain dedication; \`lichess_elite_*.zip\`
inputs are the Lichess Elite Database (${LICHESS_ELITE_DB}), a subset of that database (2400+ vs
2200+ until November 2021, 2500+ vs 2300+ after; no bullet). A \`.first6GiB\`-style input name is
the first bytes of the named monthly file, read up to its last complete game. Nothing under
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
${
	n.theoryBook
		? `
\`${n.theoryBook.manifest.book}\` is generated by \`${n.theoryBook.manifest.script}\` from the Lichess
\`chess-openings\` dataset (${n.theoryBook.manifest.source}, CC0 1.0): every move of every named opening
line, for both sides, weighted by the number of named lines through it —
${n.theoryBook.manifest.lines.toLocaleString("en-US")} lines, ${n.theoryBook.manifest.entries.toLocaleString("en-US")} entries.
Inputs are the unmodified \`a.tsv\`…\`e.tsv\` (SHA-256 in its manifest):

    ${theoryBookCommand(n.registry.BOOKS.dir, n.theoryBook.manifest)}
`
		: ""
}
The Polyglot \`Random64\` table in \`src/core/strength/book/random64.ts\` is transcribed from
Michel Van den Bergh's format description (http://hgm.nubati.net/book_format.html), which states
the table is not subject to copyright and releases its sample code into the public domain.

Note: the \`gm2600\` registry key follows the plan's naming; the file is **not** the SCID/Pascal
Georges \`gm2600.bin\`, whose licence forbids reuse without the author's permission.

| File | Bytes | SHA-256 |
|---|---|---|
${[...n.books.map(({ file }) => row(file)), ...(n.theoryBook ? [row(n.theoryBook.file)] : [])].join("\n")}
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

sliced.sh's human move-timing head is the clock model of **${up.name}** (Thomas Johnson, 2026;
the engine behind ${up.site}), exported from the checkpoints published at ${up.repo} (commit
\`${up.commit}\`). Required Notice: ${up.copyright}. The source code **and the trained weights** are licensed
under the **${up.licenseName}** (${up.licenseUrl}; SPDX \`${up.license}\`) — the weights may
only be used for non-commercial purposes, which is what sliced.sh is. The ONNX files below are
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

// ── Maia-3 policy models (`assets/models/maia3/`) ────────────────────────────────────────────

/**
 * Sizes + hashes of the exported Maia-3 models as shipped (joined) and as stored, checked
 * against the registry and the export manifest.
 */
export async function describeMaia(registry: MaiaRegistry): Promise<MaiaNotice> {
	const dir = path.join(ROOT, registry.MAIA_DIR);
	const manifestPath = path.join(dir, registry.MAIA_FILES.manifest);
	if (!existsSync(manifestPath))
		throw new Error(`${registry.MAIA_FILES.manifest} missing (run 09_export_maia3.py)`);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MaiaManifest;
	if (manifest.upstream.repo !== registry.MAIA_UPSTREAM.repo)
		throw new Error(
			`maia3 models.json repo ${manifest.upstream.repo} != registry ${registry.MAIA_UPSTREAM.repo}`
		);
	if (manifest.upstream.license !== registry.MAIA_UPSTREAM.license)
		throw new Error(
			`maia3 models.json license ${manifest.upstream.license} != registry ${registry.MAIA_UPSTREAM.license}`
		);
	const models: VendoredFile[] = [];
	const sourceNames: string[] = [];
	for (const size of registry.MAIA_SIZES) {
		const reg = registry.MAIA_MODEL_FILES[size];
		const man = manifest.models[size];
		if (!reg || !man) throw new Error(`maia3 ${size}: missing in registry or manifest`);
		// Reads the whole file or joins its parts; throws unless bytes and SHA-256 match the registry.
		const data = await readMaiaSource(dir, reg, registry.MAIA_FILES);
		const file = { name: reg.file, bytes: data.length, sha256: sha256Hex(data) };
		if (man.sha256 !== file.sha256 || man.bytes !== file.bytes || man.parts !== reg.parts)
			throw new Error(`maia3 ${size}: manifest ${man.sha256} != file ${file.sha256}`);
		models.push(file);
		sourceNames.push(...maiaSourceNames(reg, registry.MAIA_FILES));
	}
	const licenseText = await readFile(path.join(dir, registry.MAIA_FILES.license), "utf8");
	if (!licenseText.includes("GNU AFFERO GENERAL PUBLIC LICENSE"))
		throw new Error(`${registry.MAIA_DIR}${registry.MAIA_FILES.license} is not the AGPL-3.0 text`);
	const sources = await describe(dir, sourceNames);
	const sideFiles = await describe(dir, [registry.MAIA_FILES.manifest, registry.MAIA_FILES.license]);
	return { manifest, models, sources, sideFiles };
}

export function renderMaiaSection(registry: MaiaRegistry, m: MaiaNotice, website: string): string {
	const up = registry.MAIA_UPSTREAM;
	const dir = registry.MAIA_DIR;
	const row = (f: VendoredFile) =>
		`| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} | \`${f.sha256}\` |`;
	const sizeRow = (size: string) => {
		const reg = registry.MAIA_MODEL_FILES[size];
		const man = m.manifest.models[size];
		if (!reg || !man) return "";
		const diff =
			man.maxAbsProbDiffOnnxVsTorch === undefined
				? "—"
				: man.maxAbsProbDiffOnnxVsTorch.toExponential(2);
		return `| ${size.toUpperCase()} | \`${reg.file}\` | ${reg.params.toLocaleString("en-US")} | \`${reg.upstream.repo}\` | \`${reg.upstream.revision.slice(0, 12)}\` | \`${reg.upstream.checkpoint}\` (${reg.upstream.bytes.toLocaleString("en-US")} B) | \`${reg.upstream.sha256}\` | ${diff} |`;
	};
	const split = registry.MAIA_SIZES.filter((s) => (registry.MAIA_MODEL_FILES[s]?.parts ?? 1) > 1);
	const splitNote = split
		.map((s) => {
			const reg = registry.MAIA_MODEL_FILES[s];
			if (!reg) return "";
			return `\`${reg.file}\` (${reg.bytes.toLocaleString("en-US")} B) is over the Git host's 100 MB per-file cap, so the repository stores it as ${reg.parts} consecutive slices — \`${reg.file}${registry.MAIA_FILES.partSuffix}<i>\`, each but the last exactly ${registry.MAIA_FILES.partBytes.toLocaleString("en-US")} bytes. The build (\`scripts/maia-assets.ts\`) joins them, checks the joined bytes against the registry and ships one whole file; \`verify-dist\` fails the build if a slice ships.`;
		})
		.join(" ");
	return `## Maia-3 human move-policy models — \`${dir}\`

sliced.sh's move *selection* below the Elite band draws on **${up.name}** (CSSLab, University of
Toronto; Monroe, Eilender, Chalmers, Tang and Anderson, *${up.paperTitle}*, ${up.paper}), the
human move-prediction transformer published at ${up.repo} (code commit
\`${m.manifest.upstream.commit}\`) with its checkpoints on the Hugging Face hub (${up.hub}).
Required notice: ${up.copyright}. The repository is licensed under the **${up.licenseName}**
(${up.licenseUrl}; SPDX \`${up.license}\`); the model cards state no separate weight licence and
point to the repository for it, so the weights are distributed under the same licence by that
pointer. The ONNX files below are derived works of those weights (the same parameters, stored as
float16 behind \`Cast\`, opset ${m.manifest.export.opset}, exported by \`${m.manifest.export.script}\`) and are
distributed under the same licence; the AGPL text ships with the extension as \`${dir}${registry.MAIA_FILES.license}\`.
Nothing in sliced.sh's own source is derived from the Maia-3 code: the model runs through
onnxruntime-web, and the extension's input encoder is written from the paper's description.
AGPL §13 (network interaction) does not arise — the model runs on the user's machine and serves
nobody over a network.

Export: \`${m.manifest.export.script}\` (torch ${m.manifest.export.torch}, onnx ${m.manifest.export.onnx},
onnxruntime ${m.manifest.export.onnxruntime}; the input layout, parity and latency are in \`docs/models.md\`).
Each size is one checkpoint, pinned by Hugging Face revision and SHA-256:

| Size | File | Params | HF repo | Revision | Checkpoint | Checkpoint SHA-256 | max \\|Δprob\\| vs torch fp32 |
|---|---|---|---|---|---|---|---|
${registry.MAIA_SIZES.map(sizeRow).filter(Boolean).join("\n")}

### Source offer

The complete corresponding source of these models is the Maia-3 repository at
${up.repo}/commit/${m.manifest.upstream.commit} together with the checkpoints at the Hugging Face
revisions in the table above; the export tool that produced the ONNX files is in this repository.
The written offer in the Stockfish section (a durable medium on request, as AGPL-3.0 §6
requires; contact details at ${website}) covers them as well.

### Repository layout

${splitNote}

Shipped in the extension (whole files, as the build writes them):

| File | Bytes | SHA-256 |
|---|---|---|
${m.models.map(row).join("\n")}

Stored in the repository:

| File | Bytes | SHA-256 |
|---|---|---|
${[...m.sources, ...m.sideFiles].map(row).join("\n")}`;
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
	const { ENGINE_DIR, ENGINE_FILES, ENGINE_NNUE_SOURCES, nnueMirror } = registry;
	const destDir = path.join(ROOT, ENGINE_DIR);
	await mkdir(destDir, { recursive: true });

	const version = await packageVersion();
	const copied = packageFiles(ENGINE_FILES);
	await copyPackageFiles(copied, destDir);
	console.log(`copied ${copied.length} files from ${PACKAGE_NAME}@${version} to ${ENGINE_DIR}`);

	const networks: VendoredFile[] = [];
	for (const spec of ENGINE_NNUE_SOURCES) {
		if (await hasVerifiedNet(destDir, spec)) console.log(`${spec.source}: present and verified`);
		else await downloadNet(nnueMirror, spec, destDir);
		const data = await readNnueSource(destDir, spec);
		networks.push({ name: spec.name, bytes: data.length, sha256: sha256Hex(data) });
	}
	const engineFiles = await describe(destDir, [
		...copied,
		...ENGINE_NNUE_SOURCES.map((spec) => spec.source),
	]);
	const stale = staleEngineFiles(await readdir(destDir), ENGINE_FILES, ENGINE_NNUE_SOURCES);
	if (stale.length > 0)
		console.warn(
			`${ENGINE_DIR}: ${stale.length} file(s) the registry no longer ships — delete them:\n  - ${stale.join("\n  - ")}`
		);
	const [typesFile] = await describe(path.dirname(TYPES_DEST), [path.basename(TYPES_DEST)]);
	if (!typesFile) throw new Error("types file missing after copy");
	const { BOOKS } = registry;
	const books = await readBookManifests(path.join(ROOT, BOOKS.dir), [BOOKS.gm2600, BOOKS.club]);
	const [theoryBook] = await readBookManifests<TheoryBookManifest>(path.join(ROOT, BOOKS.dir), [
		BOOKS.theory,
	]);
	const fonts = await describeFonts();
	const onnxruntime = await vendorOnnxRuntime(registry);
	const models = await describeModels(registry);
	const maia = await describeMaia(registry.maia);
	await writeFile(
		DOCS_DEST,
		renderThirdParty({
			version,
			registry,
			engineFiles,
			networks,
			typesFile,
			books,
			...(theoryBook ? { theoryBook } : {}),
			fonts,
			models,
			onnxruntime,
			maia,
		})
	);
	console.log(`wrote ${path.relative(ROOT, DOCS_DEST)}`);
}

if (import.meta.main) await vendorEngine();
