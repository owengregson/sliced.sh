/** Which tabs the side panel belongs on: hosts matched from `SITE_MATCHES.chesscom`. */

import { SITE_MATCHES } from "@core/constants/match-patterns";

/**
 * `*://*.chess.com/*` → a test on `URL.hostname` (`*.` allows the bare host too,
 * as Chrome does). An unparseable pattern fails closed (matches nothing).
 */
export function hostTestFromMatchPattern(pattern: string): (hostname: string) => boolean {
	const m = /^[^:]+:\/\/([^/]+)\//.exec(pattern);
	if (!m || m[1] === undefined) return () => false;
	const hostPart = m[1];
	if (hostPart === "*") return () => true;
	if (hostPart.startsWith("*.")) {
		const base = hostPart.slice(2).toLowerCase();
		return (host) => host === base || host.endsWith(`.${base}`);
	}
	const exact = hostPart.toLowerCase();
	return (host) => host === exact;
}

const IS_SITE_HOST = hostTestFromMatchPattern(SITE_MATCHES.chesscom);

export function isChessHost(url: string | undefined): boolean {
	if (!url) return false;
	let hostname: string;
	let protocol: string;
	try {
		({ hostname, protocol } = new URL(url));
	} catch {
		return false;
	}
	if (protocol !== "http:" && protocol !== "https:") return false;
	return IS_SITE_HOST(hostname.toLowerCase());
}
