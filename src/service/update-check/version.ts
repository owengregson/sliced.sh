/** Reading and comparing Chrome extension version strings (§12.2). */

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
