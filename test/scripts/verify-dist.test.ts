// test/scripts/verify-dist.test.ts — build step 10 (§11.2).
//
// Most of `verify-dist` is pure string/object work so the rules can be exercised without a
// build; the last block assembles a miniature `dist/` in a temp directory and runs the real
// entry point over it, once clean and once broken in every way the step is meant to catch.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BUNDLE_BUDGETS,
	BUNDLES,
	checkEngineDir,
	checkJunkFiles,
	checkManifest,
	checkPackagedModels,
	checkReferenceGraph,
	checkWebAccessibleResources,
	cssRefs,
	globToRegExp,
	htmlRefs,
	isExternalRef,
	JUNK_FILE_RE,
	LICENSE_BUNDLE,
	licenseHost,
	MODEL_PART_RE,
	manifestPaths,
	type PackagedModel,
	packagedEngineFiles,
	packagedModels,
	readRegistry,
	registryHosts,
	resolveRef,
	scanBundle,
	unclassifiedHosts,
	verifyDist,
} from "../../scripts/verify-dist";
import {
	BUNDLED_NNUE,
	ENGINE_DIR,
	ENGINE_LICENSE_FILE,
	ENGINE_PROGRAM_FILES,
} from "../../src/core/constants/engine-files";

/** A stand-in for the registry's Maia-3 models: rule 8 needs a whole file at a known size. */
const MODELS: readonly PackagedModel[] = [{ path: "assets/models/maia3/maia3-79m.onnx", bytes: 4 }];

/** A stand-in for the engine registry: rule 10 wants `assets/engine/` to be exactly this. */
const ENGINE: readonly string[] = ["assets/engine/sf_19_relaxed-simd.wasm"];

const MANIFEST = {
	manifest_version: 3,
	name: "sliced.sh",
	version: "2.0.0",
	key: "AAAA",
	icons: { "128": "assets/images/sliced_128.png" },
	action: { default_icon: { "128": "assets/images/sliced_128.png" } },
	side_panel: { default_path: "pages/panel.html" },
	background: { service_worker: "js/service-worker.js", type: "module" },
	content_scripts: [
		{ js: ["js/page/chesscom-bridge.js"], world: "MAIN" },
		{ js: ["js/content.js"] },
	],
};

/**
 * v2 declares no `web_accessible_resources` (§13.3). This variant exercises the path-collection
 * and glob rules for the only shape that may ever come back — one carrying `use_dynamic_url`.
 */
const MANIFEST_WITH_WAR = {
	...MANIFEST,
	web_accessible_resources: [{ resources: ["assets/engine/*"], use_dynamic_url: true }],
};

const CLEAN_FILES = [
	"manifest.json",
	"assets/images/sliced_128.png",
	"assets/engine/sf_19_relaxed-simd.wasm",
	"pages/panel.html",
	"js/service-worker.js",
	"js/content.js",
	"js/page/chesscom-bridge.js",
];

describe("manifestPaths", () => {
	it("collects every declared path with its provenance", () => {
		const paths = manifestPaths(MANIFEST_WITH_WAR);
		expect(paths.map((p) => p.path)).toEqual([
			"assets/images/sliced_128.png",
			"assets/images/sliced_128.png",
			"pages/panel.html",
			"js/service-worker.js",
			"js/page/chesscom-bridge.js",
			"js/content.js",
			"assets/engine/*",
		]);
		expect(paths[0]?.where).toBe("icons.128");
		expect(paths[1]?.where).toBe("action.default_icon.128");
		expect(paths[4]?.where).toBe("content_scripts[0].js[0]");
		expect(paths.filter((p) => p.glob).map((p) => p.path)).toEqual(["assets/engine/*"]);
	});

	it("survives a manifest that is not an object or is missing sections", () => {
		expect(manifestPaths(null)).toEqual([]);
		expect(manifestPaths("nope")).toEqual([]);
		expect(manifestPaths({ icons: "wrong", content_scripts: 7 })).toEqual([]);
	});
});

describe("globToRegExp", () => {
	it("lets `*` span path separators, as Chrome's resource patterns do", () => {
		expect(globToRegExp("assets/engine/*").test("assets/engine/a/b.wasm")).toBe(true);
		expect(globToRegExp("assets/engine/*").test("assets/sounds/a.wav")).toBe(false);
	});
	it("escapes regex metacharacters in the literal part", () => {
		expect(globToRegExp("a.b/*").test("a.b/c")).toBe(true);
		expect(globToRegExp("a.b/*").test("axb/c")).toBe(false);
	});
});

describe("checkManifest", () => {
	it("passes a well-formed manifest whose paths all exist", () => {
		expect(checkManifest(MANIFEST, CLEAN_FILES, "2.0.0")).toEqual([]);
		expect(checkManifest(MANIFEST_WITH_WAR, CLEAN_FILES, "2.0.0")).toEqual([]);
	});

	it("refuses a web_accessible_resources block without use_dynamic_url", () => {
		const exposed = { ...MANIFEST, web_accessible_resources: [{ resources: ["assets/engine/*"] }] };
		expect(checkManifest(exposed, CLEAN_FILES, "2.0.0")).toHaveLength(1);
	});

	it("reports a missing file and an unmatched resource pattern", () => {
		const files = CLEAN_FILES.filter(
			(f) => f !== "js/content.js" && f !== "assets/engine/sf_19_relaxed-simd.wasm"
		);
		const problems = checkManifest(MANIFEST_WITH_WAR, files, "2.0.0");
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("js/content.js");
		expect(problems[1]).toContain("assets/engine/*");
		expect(problems[1]).toContain("matches no file");
	});

	it("reports a drifted version stamp, a missing key and a resurrected update_url (§12.2)", () => {
		const bad = { ...MANIFEST, version: "1.9.9", update_url: "https://sliced.sh/update" };
		delete (bad as Record<string, unknown>).key;
		const problems = checkManifest(bad, CLEAN_FILES, "2.0.0");
		expect(problems.some((p) => p.includes("expected 2.0.0"))).toBe(true);
		expect(problems.some((p) => p.includes("`key`"))).toBe(true);
		expect(problems.some((p) => p.includes("update_url"))).toBe(true);
	});

	it("reports a non-MV3 manifest and a non-object one", () => {
		expect(checkManifest({ ...MANIFEST, manifest_version: 2 }, CLEAN_FILES, "2.0.0")[0]).toContain(
			"expected 3"
		);
		expect(checkManifest(null, CLEAN_FILES, "2.0.0")).toEqual(["manifest.json is not an object"]);
	});
});

describe("reference extraction", () => {
	it("separates package-local references from external ones", () => {
		expect(isExternalRef("https://x/y")).toBe(true);
		expect(isExternalRef("data:image/png;base64,AA")).toBe(true);
		expect(isExternalRef("//cdn/x.js")).toBe(true);
		expect(isExternalRef("#app")).toBe(true);
		expect(isExternalRef("")).toBe(true);
		expect(isExternalRef("../js/panel.js")).toBe(false);
	});

	it("reads src/href out of HTML and url()/@import out of CSS", () => {
		expect(
			htmlRefs(
				`<link rel="icon" href="../assets/i.png" /><link href="https://x/y.css" />` +
					`<script src='../js/panel.js'></script>`
			)
		).toEqual(["../assets/i.png", "../js/panel.js"]);
		expect(
			cssRefs(
				`@import url("tokens.css");\n@font-face { src: url(../assets/f.woff2) format("woff2"); }`
			)
		).toEqual(["tokens.css", "../assets/f.woff2"]);
	});

	it("resolves relative to the referring file and drops query/fragment", () => {
		expect(resolveRef("pages/panel.html", "../js/panel.js")).toBe("js/panel.js");
		expect(resolveRef("css/base.css", "../assets/f.woff2?v=1#iefix")).toBe("assets/f.woff2");
		expect(resolveRef("pages/panel.html", "/js/panel.js")).toBe("js/panel.js");
		expect(resolveRef("pages/panel.html", "../../escape.js")).toBeNull();
	});
});

describe("checkReferenceGraph", () => {
	const tree: Record<string, string> = {
		"pages/panel.html": `<link rel="stylesheet" href="../css/sl-ui.css"><script src="../js/panel.js"></script>`,
		"css/sl-ui.css": `@import url("base.css");`,
		"css/base.css": `@font-face { src: url("../assets/fonts/Geist.woff2"); }`,
		"assets/fonts/Geist.woff2": "",
		"js/panel.js": "",
	};
	const read = (f: string): string | null => tree[f] ?? null;

	it("follows html → css → css → font and reports nothing when all resolve", () => {
		expect(checkReferenceGraph(["pages/panel.html"], read)).toEqual([]);
	});

	it("reports a font that the copy step forgot, transitively", () => {
		const missing = { ...tree };
		delete missing["assets/fonts/Geist.woff2"];
		const problems = checkReferenceGraph(["pages/panel.html"], (f) => missing[f] ?? null);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("css/base.css");
		expect(problems[0]).toContain("assets/fonts/Geist.woff2");
	});

	it("reports a reference that escapes the package", () => {
		const problems = checkReferenceGraph(["pages/panel.html"], (f) =>
			f === "pages/panel.html" ? `<script src="../../outside.js"></script>` : null
		);
		expect(problems[0]).toContain("resolves outside dist/");
	});
});

describe("checkWebAccessibleResources (§13.3: the fixed extension id is a probe target)", () => {
	it("passes a manifest that declares none — v2 needs none", () => {
		expect(checkWebAccessibleResources(MANIFEST)).toEqual([]);
		expect(checkWebAccessibleResources(null)).toEqual([]);
	});

	it("fails a present-but-unreadable declaration instead of waving it through", () => {
		// Chrome rejects these at load, but this rule must not be what let them past.
		for (const declared of [[], {}, "assets/engine/*", 0]) {
			const problems = checkWebAccessibleResources({ web_accessible_resources: declared });
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("not a non-empty array");
		}
	});

	it("fails the v1-shaped block that exposed the engine and the sounds to the site", () => {
		const problems = checkWebAccessibleResources({
			web_accessible_resources: [
				{
					resources: ["assets/engine/*", "assets/sounds/*"],
					matches: ["*://*.chess.com/*"],
				},
			],
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("assets/engine/*, assets/sounds/*");
		expect(problems[0]).toContain("use_dynamic_url");
	});

	it("allows a block back only with `use_dynamic_url: true` on every entry", () => {
		expect(
			checkWebAccessibleResources({
				web_accessible_resources: [{ resources: ["a.png"], use_dynamic_url: true }],
			})
		).toEqual([]);
		expect(
			checkWebAccessibleResources({
				web_accessible_resources: [
					{ resources: ["a.png"], use_dynamic_url: true },
					{ resources: ["b.png"] },
				],
			})
		).toHaveLength(1);
	});
});

describe("registry hosts", () => {
	it("derives every host from absolute URLs in the registry, plus the licence endpoint", () => {
		const hosts = registryHosts(
			{
				"urls.ts":
					'const W = "https://sliced.sh";\nexport const U = { e: "https://mirror.example/x" };',
				"models.ts": '"https://1e4.ai"',
			},
			"https://phantom.ac/slicedgg/index.php"
		);
		expect(hosts).toEqual(["1e4.ai", "mirror.example", "phantom.ac", "sliced.sh"]);
	});

	it("tolerates a licence URL that is not absolute", () => {
		expect(licenseHost("not a url")).toBeNull();
		expect(licenseHost("https://phantom.ac/x")).toBe("phantom.ac");
		expect(registryHosts({ "a.ts": '"https://sliced.sh"' }, "not a url")).toEqual(["sliced.sh"]);
	});

	it("classifies every host the real registry actually contains", () => {
		expect(unclassifiedHosts(registryHosts(readRegistry(), null))).toEqual([]);
	});
});

describe("scanBundle", () => {
	const hosts = ["phantom.ac", "sliced.sh", "www.chess.com"];

	it("flags a stray console call in a production bundle and names the line", () => {
		const problems = scanBundle("js/panel.js", "let a=1;\nconsole.warn(a);\n", {
			dev: false,
			hosts,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("1 `console.`");
		expect(problems[0]).toContain("line 2");
	});

	it("allows console in a dev bundle, and always allows the logger's computed access", () => {
		expect(scanBundle("js/panel.js", "console.warn(1)", { dev: true, hosts })).toEqual([]);
		expect(scanBundle("js/panel.js", "console[l](1)", { dev: false, hosts })).toEqual([]);
	});

	it("allows the licence host only in the service-worker bundle", () => {
		const text = `fetch("https://phantom.ac/slicedgg/index.php")`;
		expect(scanBundle(LICENSE_BUNDLE, text, { dev: false, hosts })).toEqual([]);
		for (const bundle of [BUNDLES.content, BUNDLES.panel, BUNDLES.offscreen]) {
			const leak = scanBundle(bundle, text, { dev: false, hosts });
			expect(leak, bundle).toHaveLength(1);
			expect(leak[0]).toContain("phantom.ac");
			expect(leak[0]).toContain(LICENSE_BUNDLE);
		}
	});

	it("keeps every registry host out of the page realm, SW and panel aside", () => {
		const text = `const u = "https://sliced.sh/manifest.json";`;
		expect(scanBundle(BUNDLES.serviceWorker, text, { dev: false, hosts })).toEqual([]);
		expect(scanBundle(BUNDLES.panel, text, { dev: false, hosts })).toEqual([]);
		const leak = scanBundle(BUNDLES.content, text, { dev: false, hosts });
		expect(leak).toHaveLength(1);
		expect(leak[0]).toContain("sliced.sh");
		expect(scanBundle("js/page/chesscom-bridge.js", text, { dev: false, hosts })).toHaveLength(1);
	});

	it("does not mistake a match pattern for a URL — content carries the site pattern", () => {
		const patterns = `["*://*.chess.com/*"]`;
		expect(scanBundle(BUNDLES.content, patterns, { dev: false, hosts })).toEqual([]);
		// …but a real chess.com URL in the content bundle still fails.
		expect(
			scanBundle(BUNDLES.content, `"https://www.chess.com/"`, { dev: false, hosts })
		).toHaveLength(1);
	});

	it("ignores a host it cannot classify (reported once by unclassifiedHosts instead)", () => {
		expect(
			scanBundle(BUNDLES.content, `"https://unknown.example/"`, {
				dev: false,
				hosts: ["unknown.example"],
			})
		).toEqual([]);
		expect(unclassifiedHosts(["unknown.example", "sliced.sh"])).toEqual(["unknown.example"]);
	});
});

describe("checkPackagedModels (rule 8: whole Maia-3 models, no split part)", () => {
	const sizes: Record<string, number> = { "assets/models/maia3/maia3-79m.onnx": 4 };
	const sizeOf = (f: string): number => sizes[f] ?? 0;

	it("passes when every model is present at its registered size", () => {
		expect(checkPackagedModels(Object.keys(sizes), sizeOf, MODELS)).toEqual([]);
	});

	it("reports a missing model and a model of the wrong size", () => {
		expect(checkPackagedModels([], sizeOf, MODELS)[0]).toContain("missing from dist/");
		const wrong = checkPackagedModels(Object.keys(sizes), () => 3, MODELS);
		expect(wrong).toHaveLength(1);
		expect(wrong[0]).toContain("3 bytes, the registry says 4");
	});

	it("reports a shipped split part even when the whole file is present", () => {
		const files = [...Object.keys(sizes), "assets/models/maia3/maia3-79m.onnx.part0"];
		const problems = checkPackagedModels(files, sizeOf, MODELS);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("split source part shipped");
		expect(MODEL_PART_RE.test("maia3-79m.onnx.part1")).toBe(true);
		expect(MODEL_PART_RE.test("maia3-79m.onnx")).toBe(false);
		expect(MODEL_PART_RE.test("maia3-79m.onnx.partial")).toBe(false);
	});

	it("reports a model the registry does not name under the models dir (a stale export), and only there", () => {
		// 2026-09-13: the 5M / 23M exports left the registry; a leftover file must not ship silently.
		const stale = [...Object.keys(sizes), "assets/models/maia3/maia3-5m.onnx"];
		const problems = checkPackagedModels(stale, sizeOf, MODELS);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("maia3-5m.onnx: a model the registry does not name shipped");
		// Side files and models elsewhere are not the rule's business.
		const fine = [...Object.keys(sizes), "assets/models/maia3/models.json", "assets/models/x.onnx"];
		expect(checkPackagedModels(fine, sizeOf, MODELS)).toEqual([]);
	});

	it("derives packed package expectations for Maia 79M and all six timing bands", () => {
		const models = packagedModels();
		expect(models).toHaveLength(7);
		expect(models.filter((m) => m.path.includes("/maia3/")).map((m) => m.path)).toEqual([
			"assets/models/maia3/maia3-79m.onnx.pack.gz",
		]);
		for (const m of models) {
			expect(m.bytes).toBeGreaterThan(0);
			expect(m.packed).toBe(true);
			expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});

describe("the shipped manifest", () => {
	const source = JSON.parse(
		readFileSync(path.resolve(import.meta.dir, "../../manifest.json"), "utf8")
	) as Record<string, unknown>;

	it("exposes nothing to the page: no web_accessible_resources at all (§13.3)", () => {
		expect(source.web_accessible_resources).toBeUndefined();
		expect(checkWebAccessibleResources(source)).toEqual([]);
	});

	it("still pins the key, so the id stays stable across the v1 upgrade", () => {
		expect(typeof source.key).toBe("string");
	});
});

describe("rule 9: junk files", () => {
	it("recognises Finder, Explorer and AppleDouble droppings by base name only", () => {
		for (const name of [".DS_Store", "Thumbs.db", "desktop.ini", "._Geist-Variable.woff2"])
			expect(JUNK_FILE_RE.test(name)).toBe(true);
		for (const name of ["DS_Store.md", "manifest.json", "sounds.db", "_x.txt", ".gitkeep"])
			expect(JUNK_FILE_RE.test(name)).toBe(false);
	});

	it("reports every junk file in the tree and nothing else", () => {
		expect(checkJunkFiles(["manifest.json", "assets/sounds/make_move.wav"])).toEqual([]);
		const problems = checkJunkFiles(["assets/.DS_Store", "assets/models/.DS_Store", "js/panel.js"]);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("assets/.DS_Store");
		expect(problems[1]).toContain("assets/models/.DS_Store");
	});
});

describe("rule 10: the engine directory is exactly the registry", () => {
	it("derives the packaged list from ENGINE_FILES: relaxed-SIMD programs, licence, nets", () => {
		const files = packagedEngineFiles();
		expect(files).toEqual(
			[...ENGINE_PROGRAM_FILES, ENGINE_LICENSE_FILE, ...BUNDLED_NNUE].map((n) => ENGINE_DIR + n)
		);
		// The plain-SIMD builds stopped shipping on 2026-09-13.
		for (const dropped of ["sf_19.js", "sf_19.wasm", "sf_19_smallnet.js", "sf_19_smallnet.wasm"])
			expect(files).not.toContain(ENGINE_DIR + dropped);
		expect(files.some((f) => f.endsWith(".nnue.gz"))).toBe(false);
	});

	it("passes when the directory matches, and only then", () => {
		const expected = ["assets/engine/a.js", "assets/engine/a.wasm", "assets/engine/LICENSE"];
		const others = ["manifest.json", "assets/sounds/x.wav"];
		expect(checkEngineDir([...others, ...expected], expected)).toEqual([]);
		const missing = checkEngineDir([...others, "assets/engine/a.js"], expected);
		expect(missing).toHaveLength(2);
		expect(missing[0]).toContain("assets/engine/a.wasm is missing");
		const extra = checkEngineDir(
			[...others, ...expected, "assets/engine/sf_19.wasm", "assets/engine/nn-x.nnue.gz"],
			expected
		);
		expect(extra).toHaveLength(2);
		expect(extra[0]).toContain("assets/engine/sf_19.wasm");
		expect(extra[0]).toContain("dead weight");
		expect(extra[1]).toContain("assets/engine/nn-x.nnue.gz");
	});
});

describe("verifyDist over a built tree", () => {
	const roots: string[] = [];
	const build = (files: Record<string, string>): string => {
		const root = mkdtempSync(path.join(tmpdir(), "sl-verify-"));
		roots.push(root);
		for (const [rel, body] of Object.entries(files)) {
			const full = path.join(root, rel);
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, body);
		}
		return root;
	};
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	const clean = (): Record<string, string> => ({
		"manifest.json": JSON.stringify(MANIFEST),
		"assets/images/sliced_128.png": "png",
		"assets/engine/sf_19_relaxed-simd.wasm": "wasm",
		"assets/models/maia3/maia3-79m.onnx": "onnx",
		"pages/panel.html": `<script type="module" src="../js/panel.js"></script>`,
		"js/panel.js": "export {};",
		"js/service-worker.js": `fetch("https://phantom.ac/slicedgg/index.php");`,
		"js/content.js": "(() => {})();",
		"js/page/chesscom-bridge.js": "(() => {})();",
	});

	it("passes a clean tree and reports every bundle's size", () => {
		const report = verifyDist(build(clean()), {
			version: "2.0.0",
			models: MODELS,
			engineFiles: ENGINE,
		});
		expect(report.problems).toEqual([]);
		expect(report.sizes.map((s) => s.file)).toEqual([
			"js/content.js",
			"js/page/chesscom-bridge.js",
			"js/panel.js",
			"js/service-worker.js",
		]);
		expect(report.sizes.find((s) => s.file === "js/panel.js")?.budget).toBe(
			BUNDLE_BUDGETS["js/panel.js"] ?? 0
		);
		expect(report.sizes.find((s) => s.file === "js/content.js")?.budget).toBe(
			BUNDLE_BUDGETS["js/content.js"] ?? 0
		);
		expect(report.totalBytes).toBeGreaterThan(0);
	});

	it("fails on a junk file and on an engine file the registry does not name", () => {
		const files = clean();
		files["assets/.DS_Store"] = "finder";
		files["assets/engine/sf_19.wasm"] = "stale plain-SIMD build";
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/2 problem/);
	});

	it("fails when a registered engine file did not ship", () => {
		const files = clean();
		delete files["assets/engine/sf_19_relaxed-simd.wasm"];
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/sf_19_relaxed-simd\.wasm is missing/);
	});

	it("fails when the manifest was never stamped", () => {
		const files = clean();
		delete files["manifest.json"];
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/manifest\.json is missing/);
	});

	it("fails on a bundle over its §11.2 budget rather than rounding it away", () => {
		const files = clean();
		files["js/panel.js"] = "x".repeat((BUNDLE_BUDGETS["js/panel.js"] ?? 0) + 1);
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/1 problem/);
	});

	it("reports the same bundle in a dev build instead of failing it — §11.2 budgets shipped bytes", () => {
		// A `--dev` bundle is not minified (the panel is 246.5 KiB released and 430.9 KiB dev), so a
		// budget written for the shipped artefact cannot be applied to it without silently becoming a
		// much tighter one. Enforcing it there broke `bun run build --dev`, which is the build the
		// extension is loaded unpacked from. The size and its budget are still reported.
		const files = clean();
		const over = (BUNDLE_BUDGETS["js/panel.js"] ?? 0) + 1;
		files["js/panel.js"] = "x".repeat(over);
		const report = verifyDist(build(files), {
			version: "2.0.0",
			models: MODELS,
			engineFiles: ENGINE,
			dev: true,
		});
		const row = report.sizes.find((s) => s.file === "js/panel.js");
		expect(row?.bytes).toBe(over);
		expect(row?.budget).toBe(BUNDLE_BUDGETS["js/panel.js"]);
	});

	it("fails on a stray console call, a leaked licence host and a broken HTML reference", () => {
		const files = clean();
		files["js/panel.js"] = "console.log(1)";
		files["js/content.js"] = `const u="https://phantom.ac/x";`;
		files["pages/panel.html"] = `<script src="../js/gone.js"></script>`;
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/3 problem/);
	});

	it("fails when a budgeted bundle was never built at all", () => {
		const files = clean();
		delete files["js/content.js"];
		// Missing from the manifest's content_scripts *and* from the budget list.
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/was not built/);
	});

	it("fails a release build that still carries a source map, and allows one in dev", () => {
		const files = clean();
		files["js/panel.js.map"] = '{"version":3,"sourcesContent":["…"]}';
		expect(() =>
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/must ship no source map/);
		expect(
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE, dev: true })
				.problems
		).toEqual([]);
	});

	it("fails when a model is missing, undersized, or shipped as a split part", () => {
		const missing = clean();
		delete missing["assets/models/maia3/maia3-79m.onnx"];
		expect(() =>
			verifyDist(build(missing), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/missing from dist/);
		const short = clean();
		short["assets/models/maia3/maia3-79m.onnx"] = "onn";
		expect(() =>
			verifyDist(build(short), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/registry says 4/);
		const split = clean();
		split["assets/models/maia3/maia3-79m.onnx.part0"] = "x";
		expect(() =>
			verifyDist(build(split), { version: "2.0.0", models: MODELS, engineFiles: ENGINE })
		).toThrow(/split source part shipped/);
	});

	it("keeps console out of the failure set for a dev build", () => {
		const files = clean();
		files["js/panel.js"] = "console.log(1)";
		expect(
			verifyDist(build(files), { version: "2.0.0", models: MODELS, engineFiles: ENGINE, dev: true })
				.problems
		).toEqual([]);
	});
});
