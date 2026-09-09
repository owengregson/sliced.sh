// test/scripts/stamp-manifest.test.ts — build step 9 (§11.2).
//
// The stamped manifest is what Chrome actually loads, so the two properties that matter are
// "nothing from the source manifest is lost" (above all the `key`, which pins the extension ID
// per §12.2) and "the version comes from package.json, never from the checked-in manifest".
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEV_NAME_SUFFIX, stampedManifest } from "../../scripts/stamp-manifest";

const SOURCE = JSON.parse(
	readFileSync(path.resolve(import.meta.dir, "../../manifest.json"), "utf8")
) as Record<string, unknown>;

describe("stampedManifest", () => {
	it("stamps the version and keeps every other source key byte for byte", () => {
		const out = stampedManifest(SOURCE, { dev: false, version: "9.9.9" });
		expect(out.version).toBe("9.9.9");
		expect(out.key).toBe(SOURCE.key);
		expect(out.name).toBe(SOURCE.name);
		expect(Object.keys(out).sort()).toEqual(Object.keys(SOURCE).sort());
		expect(out.version_name).toBeUndefined();
	});

	it("marks a dev build in the two places Chrome renders (no unknown manifest keys)", () => {
		const out = stampedManifest(SOURCE, { dev: true, version: "2.0.0", build: "2026-09-09" });
		expect(out.name).toBe(`${String(SOURCE.name)}${DEV_NAME_SUFFIX}`);
		expect(out.version_name).toBe("2.0.0-dev+2026-09-09");
		expect(out.version).toBe("2.0.0");
	});

	it("falls back to a bare -dev suffix without a build stamp, and rejects a non-object", () => {
		expect(stampedManifest(SOURCE, { dev: true, version: "2.0.0" }).version_name).toBe("2.0.0-dev");
		expect(() => stampedManifest(null, { dev: false, version: "2.0.0" })).toThrow(/not an object/);
	});
});
