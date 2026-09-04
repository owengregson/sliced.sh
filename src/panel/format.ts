/**
 * Small display formatters shared by the panel views (Task 23). Dates follow the copy examples of
 * Appendix F §7.2 ("12 Aug 2026"); the masked key keeps the prefix and the first group only.
 */

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	year: "numeric",
	timeZone: "UTC",
});

/** "12 Aug 2026" for an epoch-ms timestamp. */
export function formatDate(ms: number): string {
	return DATE_FORMAT.format(new Date(ms));
}

const MASK_CHAR = "•";

/** "SL-7F3K-AB12-CD34" → "SL-7F3K-••••-••••" (every group after the first is masked). */
export function maskLicenseKey(key: string): string {
	const groups = key.split("-");
	return groups.map((group, i) => (i < 2 ? group : MASK_CHAR.repeat(group.length))).join("-");
}

/** "3.1" for 3140 ms (one decimal, seconds). */
export function formatSeconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}
