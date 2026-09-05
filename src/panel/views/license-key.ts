/**
 * License-key auto-formatting (Appendix F §4.1): `SL-XXXX-XXXX-XXXX`, uppercase, dashes inserted
 * while typing, capped at the full length. The `SL` prefix is implied — typing it, pasting it or
 * leaving it out all format the same — and a lone leading `S` or `L` is read as the prefix being
 * typed. Formatting is edit-aware: separators are only appended while the value grows, so
 * Backspace can always walk back to an empty field; an insertion inside the prefix zone of an
 * already-prefixed value (typing the key as printed — `S`, `L`, `-` — into a field that already
 * shows `SL-`, or inserting at index 0) never turns the shown prefix into body; and
 * `caretAfterFormat` keeps the caret next to the character the user just edited.
 */

const PREFIX = "SL";
const SEPARATOR = "-";
const GROUP_LENGTH = 4;
const GROUP_COUNT = 3;
const BODY_LENGTH = GROUP_LENGTH * GROUP_COUNT;
const ALNUM = /[A-Z0-9]/;
const PREFIX_CHARS = /^[SL]+/;

export const LICENSE_KEY_LENGTH = PREFIX.length + GROUP_COUNT * (SEPARATOR.length + GROUP_LENGTH);

function significant(raw: string): string {
	return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** How many leading characters of `chars` are the prefix (or a prefix being typed). */
function prefixLength(chars: string): number {
	if (chars.startsWith(PREFIX)) return PREFIX.length;
	return chars.length === 1 && PREFIX.includes(chars) ? 1 : 0;
}

/** Alphanumeric body of the key (after the prefix), uppercase, at most 12 characters. */
export function licenseKeyBody(raw: string): string {
	const chars = significant(raw);
	return chars.slice(prefixLength(chars), prefixLength(chars) + BODY_LENGTH);
}

function joinGroups(body: string): string {
	const groups: string[] = [];
	for (let i = 0; i < body.length; i += GROUP_LENGTH) groups.push(body.slice(i, i + GROUP_LENGTH));
	return [PREFIX, ...groups].join(SEPARATOR);
}

/** Length of the leading `SL-` portion (`S`, `SL` or `SL-`) that a formatted value shows. */
function shownPrefixLength(value: string): number {
	const shown = PREFIX + SEPARATOR;
	let n = 0;
	while (n < shown.length && n < value.length && value.charAt(n) === shown.charAt(n)) n += 1;
	return n;
}

/**
 * Body for a pure insertion into `previous` that lands at or before the end of its shown prefix:
 * prefix characters typed there (`S`, `L`, `-`) are the prefix being typed and are dropped; any
 * other characters are body, placed before the existing body. `null` when the edit is not such
 * an insertion (the caller falls back to formatting the raw value).
 */
function bodyForPrefixZoneInsertion(trimmed: string, previous: string): string | null {
	const delta = trimmed.length - previous.length;
	if (delta <= 0) return null;
	let at = 0;
	while (at < previous.length && trimmed.charAt(at) === previous.charAt(at)) at += 1;
	if (at > shownPrefixLength(previous)) return null;
	if (trimmed.slice(0, at) + trimmed.slice(at + delta) !== previous) return null;
	const inserted = significant(trimmed.slice(at, at + delta)).replace(PREFIX_CHARS, "");
	return (inserted + licenseKeyBody(previous)).slice(0, BODY_LENGTH);
}

/**
 * `""` for an empty body; otherwise `SL-` followed by the dashed groups typed so far. With
 * `previous` (the field's value before this edit) a shrinking edit never re-appends the prefix
 * or a trailing separator — deleting from `SL-` reaches `""` instead of bouncing back — and an
 * insertion in the prefix zone of an already-prefixed value is read as the prefix being typed.
 */
export function formatLicenseKey(raw: string, previous = ""): string {
	const trimmed = raw.trim();
	if (significant(trimmed) === "") return "";
	const shrinking = trimmed.length < previous.length;
	const zoneBody =
		previous === "" || shrinking ? null : bodyForPrefixZoneInsertion(trimmed, previous);
	if (zoneBody !== null) return zoneBody === "" ? PREFIX + SEPARATOR : joinGroups(zoneBody);
	const body = licenseKeyBody(trimmed);
	if (body === "") return shrinking ? "" : PREFIX + SEPARATOR;
	return joinGroups(body);
}

export function isCompleteLicenseKey(formatted: string): boolean {
	return licenseKeyBody(formatted).length === BODY_LENGTH && formatted.length === LICENSE_KEY_LENGTH;
}

/**
 * Caret position in `formatted` that follows the same significant characters as `caret` did in
 * `raw` (the prefix the formatter inserted counts as already passed).
 */
export function caretAfterFormat(raw: string, caret: number, formatted: string): number {
	const before = significant(raw.slice(0, caret));
	const all = significant(raw);
	const inserted = PREFIX.length - prefixLength(all);
	const target = before.length + inserted;
	let seen = 0;
	for (let i = 0; i < formatted.length; i += 1) {
		if (seen >= target) return ALNUM.test(formatted.slice(i)) ? i : formatted.length;
		if (ALNUM.test(formatted.charAt(i))) seen += 1;
	}
	return formatted.length;
}
