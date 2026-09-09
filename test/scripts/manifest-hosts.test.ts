// test/scripts/manifest-hosts.test.ts
/**
 * The SW's NNUE download relies on `host_permissions` (extension fetches to
 * covered hosts bypass CORS; the mirror redirects and sends no
 * `Access-Control-Allow-Origin`). The manifest is JSON, so this keeps it and
 * `URLS.nnueMirrorHosts` in agreement.
 *
 * Task 34 adds the same guard for the ChessMimic band host: every band the registry marks as
 * *not* bundled would be fetched from `URLS.chessmimicBandBase` by the service worker, which
 * needs a `host_permissions` entry for that origin. Today all three bands are bundled, so the
 * manifest correctly carries no such entry and the check is vacuous — it exists so that flipping
 * a band to `bundled: false` fails here instead of at runtime.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHESSMIMIC_BAND_FILES, CHESSMIMIC_BANDS } from "@core/constants/models";
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

	it("cover the ChessMimic band host whenever a registered band is not bundled (Task 34)", () => {
		const onDemand = CHESSMIMIC_BANDS.filter((b) => !CHESSMIMIC_BAND_FILES[b].bundled);
		const origin = new URL(URLS.chessmimicBandBase).origin;
		const covered = manifest.host_permissions.some((p) => p.startsWith(`${origin}/`));
		if (onDemand.length > 0) {
			// Fetching from an origin with no host permission is subject to CORS and would fail;
			// add `<origin>/*` to `host_permissions` (and to this expectation's reasoning).
			expect({ onDemand, origin, covered }).toEqual({ onDemand, origin, covered: true });
		} else {
			// Nothing downloads today, so the manifest must not ask for the permission either.
			expect({ onDemand, origin, covered }).toEqual({ onDemand, origin, covered: false });
		}
	});
});
