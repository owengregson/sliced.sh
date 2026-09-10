/**
 * Hostname → `Site` (Task 21). The only source of the site hostname is the
 * `SITE_MATCHES` pattern (C1); a pattern `*://*.chess.com/*` names the host
 * `chess.com`, and a hostname matches when it equals the host or ends with
 * `.<host>`.
 */

import { SITE_MATCHES } from "@core/constants/match-patterns";
import type { Site } from "@typedefs/game";

const MATCH_HOST_RE = /^[^:]+:\/\/(?:\*\.)?([^/*]+)\//;

/** `*://*.chess.com/*` → `chess.com`; `null` when the pattern has no host. */
export function hostOfMatchPattern(pattern: string): string | null {
	return MATCH_HOST_RE.exec(pattern)?.[1] ?? null;
}

export function hostMatches(hostname: string, host: string): boolean {
	const h = hostname.toLowerCase();
	return h === host || h.endsWith(`.${host}`);
}

export function detectSite(hostname: string): Site | null {
	const host = hostOfMatchPattern(SITE_MATCHES.chesscom);
	return host !== null && hostMatches(hostname, host) ? "chesscom" : null;
}
