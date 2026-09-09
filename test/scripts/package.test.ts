// test/scripts/package.test.ts — build step 11 (§11.2).
//
// `verify-dist` checks the directory; the zip is what people actually install, so the property
// worth testing is that the archive contains exactly the directory that was verified — at the
// archive root, with no `dist/` prefix in front of `manifest.json`.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { missingEntries, packageDist, releaseZipName } from "../../scripts/package";

const roots: string[] = [];

function tempTree(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "sl-package-"));
	roots.push(root);
	for (const [rel, body] of Object.entries(files)) {
		const full = path.join(root, rel);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	return root;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("releaseZipName", () => {
	it("is `sliced-<version>.zip`", () => {
		expect(releaseZipName("2.0.0")).toBe("sliced-2.0.0.zip");
	});
});

describe("missingEntries", () => {
	it("reports files on disk that never became archive entries", () => {
		expect(missingEntries(["a.js", "b/c.css"], ["a.js", "b/c.css"])).toEqual([]);
		expect(missingEntries(["a.js", "b/c.css"], ["a.js"])).toEqual(["b/c.css"]);
	});
});

describe("packageDist", () => {
	it("archives every file at the root of the zip", async () => {
		const dist = tempTree({
			"manifest.json": '{"manifest_version":3}',
			"js/panel.js": "export {};",
			"assets/images/logo.png": "png",
			"css/views/live.css": ".a{}",
		});
		const out = mkdtempSync(path.join(tmpdir(), "sl-release-"));
		roots.push(out);
		const result = await packageDist(dist, "9.9.9", out);
		expect(result.file).toBe(path.join(out, "sliced-9.9.9.zip"));
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.entries).toEqual([
			"assets/images/logo.png",
			"css/views/live.css",
			"js/panel.js",
			"manifest.json",
		]);
		expect(Bun.file(result.file).size).toBe(result.bytes);
	});
});
