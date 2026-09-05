/**
 * License-key auto-formatting (Appendix F §4.1): `SL-XXXX-XXXX-XXXX`, uppercase, dashes inserted
 * while typing, capped at the full length. The `SL` prefix is implied — typing it, pasting it or
 * leaving it out all format the same — and a lone leading `S` or `L` is read as the prefix being
 * typed. Formatting is edit-aware: separators are only appended while the value grows, so
 * Backspace can always walk back to an empty field, and `caretAfterFormat` keeps the caret next to
 * the character the user just edited.
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

/**
 * `""` for an empty body; otherwise `SL-` followed by the dashed groups typed so far. With
 * `previous` (the field's value before this edit) a shrinking edit never re-appends the prefix
 * or a trailing separator — deleting from `SL-` reaches `""` instead of bouncing back.
 */
export function formatLicenseKey(raw: string, previous = ""): string {
	const trimmed = raw.trim();
	const body = licenseKeyBody(trimmed);
	const shrinking = trimmed.length < previous.length;
	if (body === "") return shrinking || significant(trimmed) === "" ? "" : PREFIX + SEPARATOR;
	const groups: string[] = [];
	for (let i = 0; i < body.length; i += GROUP_LENGTH) groups.push(body.slice(i, i + GROUP_LENGTH));
	return [PREFIX, ...groups].join(SEPARATOR);
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
		if (seen >= target) return i;
		if (ALNUM.test(formatted.charAt(i))) seen += 1;
	}
	return formatted.length;
}
