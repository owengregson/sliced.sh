// test/scripts/verify-dist.test.ts — build step 10 (§11.2).
//
// Most of `verify-dist` is pure string/object work so the rules can be exercised without a
// build; the last block assembles a miniature `dist/` in a temp directory and runs the real
// entry point over it, once clean and once broken in every way the step is meant to catch.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BUNDLE_BUDGETS,
	checkManifest,
	checkReferenceGraph,
	cssRefs,
	globToRegExp,
	htmlRefs,
	isExternalRef,
	LICENSE_BUNDLE,
	licenseHost,
	manifestPaths,
	resolveRef,
	scanBundle,
	verifyDist,
} from "../../scripts/verify-dist";

const MANIFEST = {
	manifest_version: 3,
	name: "sliced.gg",
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
	web_accessible_resources: [{ resources: ["assets/engine/*"] }],
};

const CLEAN_FILES = [
	"manifest.json",
	"assets/images/sliced_128.png",
	"assets/engine/sf_18.wasm",
	"pages/panel.html",
	"js/service-worker.js",
	"js/content.js",
	"js/page/chesscom-bridge.js",
];

describe("manifestPaths", () => {
	it("collects every declared path with its provenance", () => {
		const paths = manifestPaths(MANIFEST);
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
	});

	it("reports a missing file and an unmatched resource pattern", () => {
		const files = CLEAN_FILES.filter(
			(f) => f !== "js/content.js" && f !== "assets/engine/sf_18.wasm"
		);
		const problems = checkManifest(MANIFEST, files, "2.0.0");
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

describe("scanBundle", () => {
	const host = "phantom.ac";

	it("flags a stray console call in a production bundle and names the line", () => {
		const problems = scanBundle("js/panel.js", "let a=1;\nconsole.warn(a);\n", { dev: false, host });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("1 `console.`");
		expect(problems[0]).toContain("line 2");
	});

	it("allows console in a dev bundle, and always allows the logger's computed access", () => {
		expect(scanBundle("js/panel.js", "console.warn(1)", { dev: true, host })).toEqual([]);
		expect(scanBundle("js/panel.js", "console[l](1)", { dev: false, host })).toEqual([]);
	});

	it("allows the licence host only in the service-worker bundle", () => {
		const text = `fetch("https://${host}/slicedgg/index.php")`;
		expect(scanBundle(LICENSE_BUNDLE, text, { dev: false, host })).toEqual([]);
		const leak = scanBundle("js/content.js", text, { dev: false, host });
		expect(leak).toHaveLength(1);
		expect(leak[0]).toContain(host);
		expect(leak[0]).toContain(LICENSE_BUNDLE);
	});

	it("skips the host rule when the licence URL is not absolute", () => {
		expect(licenseHost("not a url")).toBeNull();
		expect(licenseHost("https://phantom.ac/slicedgg/index.php")).toBe("phantom.ac");
		expect(scanBundle("js/content.js", "phantom.ac", { dev: false, host: null })).toEqual([]);
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
		"assets/engine/sf_18.wasm": "wasm",
		"pages/panel.html": `<script type="module" src="../js/panel.js"></script>`,
		"js/panel.js": "export {};",
		"js/service-worker.js": `fetch("https://phantom.ac/slicedgg/index.php");`,
		"js/content.js": "(() => {})();",
		"js/page/chesscom-bridge.js": "(() => {})();",
	});

	it("passes a clean tree and reports every bundle's size", () => {
		const report = verifyDist(build(clean()), { version: "2.0.0" });
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

	it("fails when the manifest was never stamped", () => {
		const files = clean();
		delete files["manifest.json"];
		expect(() => verifyDist(build(files), { version: "2.0.0" })).toThrow(/manifest\.json is missing/);
	});

	it("fails on a bundle over its §11.2 budget rather than rounding it away", () => {
		const files = clean();
		files["js/panel.js"] = "x".repeat((BUNDLE_BUDGETS["js/panel.js"] ?? 0) + 1);
		expect(() => verifyDist(build(files), { version: "2.0.0" })).toThrow(/1 problem/);
	});

	it("fails on a stray console call, a leaked licence host and a broken HTML reference", () => {
		const files = clean();
		files["js/panel.js"] = "console.log(1)";
		files["js/content.js"] = `const u="https://phantom.ac/x";`;
		files["pages/panel.html"] = `<script src="../js/gone.js"></script>`;
		expect(() => verifyDist(build(files), { version: "2.0.0" })).toThrow(/3 problem/);
	});

	it("keeps console out of the failure set for a dev build", () => {
		const files = clean();
		files["js/panel.js"] = "console.log(1)";
		expect(verifyDist(build(files), { version: "2.0.0", dev: true }).problems).toEqual([]);
	});
});
