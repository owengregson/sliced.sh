/**
 * License-key auto-formatting (Appendix F §4.1): `SL-XXXX-XXXX-XXXX`, uppercase, dashes inserted
 * while typing, capped at the full length. The prefix is shown only once the user has typed it —
 * `S` shows `S`, `SL` shows `SL`, and `SL-` appears when the dash or the first body character
 * follows — while a value with no prefix at all (`7F3K…`, typed or pasted) gets `SL-` prepended
 * on its first body character. Every character after a shown `SL-` is body (the body alphabet is
 * not restricted), so `SL-SA12-BC34-DE56` types as printed. Formatting is edit-aware: an insertion
 * at or before the end of an already shown `SL-` (index 0, say) never turns that prefix into body,
 * and `caretAfterFormat` keeps the caret next to the character the user just edited.
 */

const PREFIX = "SL";
const SEPARATOR = "-";
const GROUP_LENGTH = 4;
const GROUP_COUNT = 3;
const BODY_LENGTH = GROUP_LENGTH * GROUP_COUNT;
const ALNUM = /[A-Z0-9]/;

export const LICENSE_KEY_LENGTH = PREFIX.length + GROUP_COUNT * (SEPARATOR.length + GROUP_LENGTH);

function significant(raw: string): string {
	return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Leading characters of `chars` that are the typed prefix: `SL`, or a lone `S`. */
function prefixLength(chars: string): number {
	if (chars.startsWith(PREFIX)) return PREFIX.length;
	return chars === PREFIX.charAt(0) ? 1 : 0;
}

/** Alphanumeric body of the key (after the typed prefix), uppercase, at most 12 characters. */
export function licenseKeyBody(raw: string): string {
	const chars = significant(raw);
	const n = prefixLength(chars);
	return chars.slice(n, n + BODY_LENGTH);
}

function joinGroups(body: string): string {
	const groups: string[] = [];
	for (let i = 0; i < body.length; i += GROUP_LENGTH) groups.push(body.slice(i, i + GROUP_LENGTH));
	return [PREFIX, ...groups].join(SEPARATOR);
}

/** A prefix-only value renders exactly what was typed: `S`, `SL`, or `SL-` once the dash follows. */
function typedPrefix(trimmed: string, chars: string): string {
	if (chars !== PREFIX) return chars;
	const compact = trimmed.toUpperCase().replace(/\s/g, "");
	return compact.startsWith(PREFIX + SEPARATOR) ? PREFIX + SEPARATOR : PREFIX;
}

const SHOWN_PREFIX = PREFIX + SEPARATOR;

/**
 * Body for a pure insertion into a `previous` that shows the full `SL-`, landing at or before
 * the end of that prefix: the inserted characters are body placed before the existing body (the
 * shown prefix stays the prefix). A whole prefixed key inserted there — a paste after typing
 * `SL-` — is read as that key. `null` when the edit is not such an insertion.
 */
function bodyForPrefixZoneInsertion(trimmed: string, previous: string): string | null {
	if (!previous.startsWith(SHOWN_PREFIX)) return null;
	const delta = trimmed.length - previous.length;
	if (delta <= 0) return null;
	let at = 0;
	while (at < previous.length && trimmed.charAt(at) === previous.charAt(at)) at += 1;
	if (at > SHOWN_PREFIX.length) return null;
	if (trimmed.slice(0, at) + trimmed.slice(at + delta) !== previous) return null;
	let inserted = significant(trimmed.slice(at, at + delta));
	if (inserted.startsWith(PREFIX) && inserted.length >= PREFIX.length + BODY_LENGTH)
		inserted = inserted.slice(PREFIX.length);
	return (inserted + licenseKeyBody(previous)).slice(0, BODY_LENGTH);
}

/**
 * `""` for an empty value; the typed prefix alone while only the prefix has been typed; otherwise
 * `SL-` followed by the dashed groups of the body. `previous` (the field's value before this
 * edit) lets an insertion in the prefix zone of a fully prefixed value keep that prefix.
 */
export function formatLicenseKey(raw: string, previous = ""): string {
	const trimmed = raw.trim();
	const chars = significant(trimmed);
	if (chars === "") return "";
	const zoneBody = bodyForPrefixZoneInsertion(trimmed, previous);
	if (zoneBody !== null && zoneBody !== "") return joinGroups(zoneBody);
	const body = licenseKeyBody(trimmed);
	return body === "" ? typedPrefix(trimmed, chars) : joinGroups(body);
}

export function isCompleteLicenseKey(formatted: string): boolean {
	return licenseKeyBody(formatted).length === BODY_LENGTH && formatted.length === LICENSE_KEY_LENGTH;
}

/**
 * Caret position in `formatted` that follows the same significant characters as `caret` did in
 * `raw` (prefix characters the formatter inserted count as already passed); when only separators
 * remain past that point the caret goes to the end.
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
