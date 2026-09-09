/**
 * "Update available" poll (§12.2).
 *
 * v1 self-hosted a CRX and pointed the manifest's `update_url` at it. Since 2024-25 Chrome
 * installs self-hosted extensions only by enterprise policy, so v2 drops `update_url`, ships a
 * zip plus the unpacked folder, and asks the site directly: the same 6 h alarm that revalidates
 * the licence (`ALARM_NAMES.licenseRevalidate`) fetches `URLS.websiteManifest` and compares its
 * `version` with this build's `__SL_VERSION__`. The verdict is one boolean in
 * `LOCAL_KEYS.updateAvailable`, which the panel shell mirrors through `storage.onChanged`; the
 * router raises the Update view (Appendix F §4.8) when it is set and no game is live, and the
 * shell keeps an info banner after "Later".
 *
 * Offline tolerance (Appendix H.12): only an explicit, parseable answer from the site moves the
 * flag. A network error, a non-200, a body that is not JSON, or a `version` that is not a
 * version string all leave the stored value exactly as it was — an outage must not make the
 * panel claim an update, nor withdraw one it already announced.
 *
 * The failure modes here are *permanent-looking*: a missing `host_permissions` entry (CORS), a
 * site that serves a PWA web-app manifest at that path (no `version` field), or a path that
 * 404s all produce "no update available" forever and look identical to a healthy check. So a
 * failed read is a `log.warn` carrying the URL and a machine-readable `reason`, not a `debug`
 * line: `log.warn` reaches the service-worker console *and* the panel's Engine log through the
 * log bridge, which makes the silent-forever path visible in the product's own diagnostics.
 * `manifest.json` carries the `host_permissions` entry for the product origin
 * (`test/scripts/manifest-hosts.test.ts` asserts it) so CORS is not one of them.
 *
 * The flag is written only when it changes: the panel re-renders on `storage.onChanged`, and a
 * write every six hours with the same value would re-raise the interrupt after the user chose
 * "Later".
 */

import { chromeLocalGet, chromeLocalRemove, chromeLocalSet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TIMINGS } from "@core/constants/timings";
import { URLS } from "@core/constants/urls";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UpdateCheckOptions {
	fetch?: FetchLike;
	/** Defaults to `URLS.websiteManifest`. */
	url?: string;
	/** Defaults to the build's `__SL_VERSION__`. */
	currentVersion?: string;
	/**
	 * Defaults to `TIMINGS.licenseValidateTimeoutMs`: this rides the licence alarm and hits a
	 * static file on the same product site, so it gets the same budget rather than its own.
	 */
	timeoutMs?: number;
}

export type UpdateOutcome = "current" | "available" | "unreachable";

/**
 * Why a check could not read the published manifest. `no-version` is the one that most looks
 * healthy: the site answered 200 with JSON that simply is not the extension manifest.
 */
export type UnreachableReason = "network" | "http-status" | "not-json" | "no-version";

export interface UpdateCheckResult {
	outcome: UpdateOutcome;
	/** The site's version, or `null` when it could not be read. */
	latest: string | null;
	current: string;
	/** Whether `LOCAL_KEYS.updateAvailable` was written (it is written only on a change). */
	changed: boolean;
	/** `null` on a successful read. */
	reason: UnreachableReason | null;
}

/** A Chrome extension version: one to four dot-separated integers. */
export const VERSION_RE = /^\d{1,5}(?:\.\d{1,5}){0,3}$/;

export function isVersion(value: unknown): value is string {
	return typeof value === "string" && VERSION_RE.test(value);
}

/** `-1` / `0` / `1`, comparing component-wise with missing components read as 0. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	const parts = Math.max(left.length, right.length);
	for (let i = 0; i < parts; i += 1) {
		const x = Number(left[i] ?? "0");
		const y = Number(right[i] ?? "0");
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/** Whether the site's `latest` is strictly newer than the running build. */
export function isNewerVersion(latest: string, current: string): boolean {
	if (!isVersion(latest) || !isVersion(current)) return false;
	return compareVersions(latest, current) > 0;
}

/** The `version` of a fetched manifest body, or `null` when it is unusable. */
export function readPublishedVersion(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const version = (body as { version?: unknown }).version;
	return isVersion(version) ? version : null;
}

/**
 * Write the flag only when it differs from what is stored; returns whether it was written.
 * `LOCAL_KEYS.updateVersion` carries the version the panel names in the §4.8 copy ("sliced 2.1
 * is ready" is about the *site's* version, not the running one) and follows the flag.
 */
async function storeVerdict(available: boolean, latest: string): Promise<boolean> {
	const storedFlag = (await chromeLocalGet(LOCAL_KEYS.updateAvailable)) === true;
	const storedVersion = await chromeLocalGet(LOCAL_KEYS.updateVersion);
	if (storedFlag === available && (available ? storedVersion === latest : storedVersion === null))
		return false;
	if (available) await chromeLocalSet(LOCAL_KEYS.updateVersion, latest);
	else await chromeLocalRemove(LOCAL_KEYS.updateVersion);
	// The flag is written last: the panel reacts to it, and it must never fire before the
	// version it refers to is readable.
	if (storedFlag !== available) await chromeLocalSet(LOCAL_KEYS.updateAvailable, available);
	return true;
}

/**
 * Fetch the published manifest and reconcile `LOCAL_KEYS.updateAvailable` with it. Never throws
 * for a network reason; a `chrome.storage` failure does propagate, and the alarm dispatcher
 * logs it.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
	const current = options.currentVersion ?? __SL_VERSION__;
	const url = options.url ?? URLS.websiteManifest;
	const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
	const timeoutMs = options.timeoutMs ?? TIMINGS.licenseValidateTimeoutMs;

	let latest: string | null = null;
	let reason: UnreachableReason | null = null;
	try {
		const response = await fetchImpl(url, {
			cache: "no-store",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			reason = "http-status";
			throw new Error(`HTTP ${response.status}`);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			reason = "not-json";
			throw error;
		}
		latest = readPublishedVersion(body);
		if (latest === null) {
			reason = "no-version";
			throw new Error(`no \`version\` string in the JSON served at ${url}`);
		}
	} catch (error) {
		// Offline, blocked, or a site that answered with something else: leave the flag alone,
		// but say so loudly enough to be seen — see the module comment.
		reason = reason ?? "network";
		log.warn("update-check: could not read the published manifest", {
			url,
			reason,
			error: errorMessage(error),
		});
		return { outcome: "unreachable", latest: null, current, changed: false, reason };
	}

	const available = isNewerVersion(latest, current);
	const changed = await storeVerdict(available, latest);
	if (changed) log.info("update-check", { current, latest, available });
	return { outcome: available ? "available" : "current", latest, current, changed, reason: null };
}
