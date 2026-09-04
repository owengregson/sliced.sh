/**
 * License-key auto-formatting (Appendix F §4.1): `SL-XXXX-XXXX-XXXX`, uppercase, dashes inserted
 * while typing, capped at the full length. The `SL` prefix is implied — typing it, pasting it or
 * leaving it out all format the same — and a lone leading `S` is read as the prefix being typed.
 */

const PREFIX = "SL";
const SEPARATOR = "-";
const GROUP_LENGTH = 4;
const GROUP_COUNT = 3;
const BODY_LENGTH = GROUP_LENGTH * GROUP_COUNT;

export const LICENSE_KEY_LENGTH = PREFIX.length + GROUP_COUNT * (SEPARATOR.length + GROUP_LENGTH);

/** Alphanumeric body of the key (after the prefix), uppercase, at most 12 characters. */
export function licenseKeyBody(raw: string): string {
	let chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (chars.startsWith(PREFIX)) chars = chars.slice(PREFIX.length);
	else if (chars === PREFIX[0]) chars = "";
	return chars.slice(0, BODY_LENGTH);
}

/** `""` for empty input; otherwise `SL-` followed by the dashed groups typed so far. */
export function formatLicenseKey(raw: string): string {
	if (raw.replace(/[^A-Za-z0-9]/g, "") === "") return "";
	const body = licenseKeyBody(raw);
	const groups: string[] = [];
	for (let i = 0; i < body.length; i += GROUP_LENGTH) groups.push(body.slice(i, i + GROUP_LENGTH));
	return [PREFIX, ...groups].join(SEPARATOR) + (groups.length === 0 ? SEPARATOR : "");
}

export function isCompleteLicenseKey(formatted: string): boolean {
	return licenseKeyBody(formatted).length === BODY_LENGTH && formatted.length === LICENSE_KEY_LENGTH;
}
