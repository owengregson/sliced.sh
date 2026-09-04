// test/scripts/manifest-hosts.test.ts
/**
 * The SW's NNUE download relies on `host_permissions` (extension fetches to
 * covered hosts bypass CORS; the mirror redirects and sends no
 * `Access-Control-Allow-Origin`). The manifest is JSON, so this keeps it and
 * `URLS.nnueMirrorHosts` in agreement.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URLS } from "@core/constants/urls";

const manifest = JSON.parse(
	readFileSync(path.resolve(import.meta.dir, "../../manifest.json"), "utf8")
) as { host_permissions: string[] };

describe("manifest host_permissions", () => {
	it("contain every NNUE mirror host pattern from the registry", () => {
		for (const host of URLS.nnueMirrorHosts) expect(manifest.host_permissions).toContain(host);
	});

	it("cover the mirror URL itself", () => {
		const origin = new URL(URLS.nnueMirror).origin;
		expect(URLS.nnueMirrorHosts.some((p) => p.startsWith(`${origin}/`))).toBe(true);
	});
});
