// test/scripts/manifest-hosts.test.ts
/**
 * The SW's NNUE download relies on `host_permissions` (extension fetches to
 * covered hosts bypass CORS; the mirror redirects and sends no
 * `Access-Control-Allow-Origin`). The manifest is JSON, so this keeps it and
 * `URLS.nnueMirrorHosts` in agreement.
 *
 * Task 34 adds the same guard for the ChessMimic band host: every band the registry marks as
 * *not* bundled would be fetched from `URLS.chessmimicBandBase` by the service worker, which
 * needs a `host_permissions` entry for that origin.
 *
 * Task 31 makes that origin permanently required for a different reason: the §12.2 update poll
 * fetches `URLS.websiteManifest` from the same origin on the licence alarm, and without the
 * permission that fetch is subject to CORS. Absent an `Access-Control-Allow-Origin` header it
 * would fail forever and be indistinguishable from "no update available" — the same hazard this
 * file already asserts for the NNUE mirror.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SITE_MATCHES } from "@core/constants/match-patterns";
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

	it("cover the product origin, which the §12.2 update poll fetches on every licence alarm", () => {
		const origin = new URL(URLS.websiteManifest).origin;
		expect(origin).toBe(new URL(URLS.website).origin);
		// Without this the fetch is a cross-origin request from the service worker and fails CORS
		// unless the site sends `Access-Control-Allow-Origin`, which we do not control from here.
		expect(manifest.host_permissions.some((p) => p.startsWith(`${origin}/`))).toBe(true);
	});

	it("cover the ChessMimic band host whenever a registered band is not bundled (Task 34)", () => {
		const onDemand = CHESSMIMIC_BANDS.filter((b) => !CHESSMIMIC_BAND_FILES[b].bundled);
		const origin = new URL(URLS.chessmimicBandBase).origin;
		const covered = manifest.host_permissions.some((p) => p.startsWith(`${origin}/`));
		// Fetching from an origin with no host permission is subject to CORS and would fail.
		// The bands share the product origin, which the update poll already requires, so this is
		// satisfied today whether or not a band is on-demand; it stays as the guard for the day a
		// band moves to a different host.
		expect({ onDemand, origin, covered }).toEqual({ onDemand, origin, covered: true });
	});

	it("declare no host permission that nothing in the registry asks for", () => {
		const known = [
			SITE_MATCHES.chesscom,
			SITE_MATCHES.lichess,
			...URLS.nnueMirrorHosts,

			`${new URL(URLS.website).origin}/*`,
		];
		for (const pattern of manifest.host_permissions) expect(known).toContain(pattern);
	});
});
