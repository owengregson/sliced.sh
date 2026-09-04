/**
 * `LicenseClient` over the phantom.ac endpoint (§3.6):
 * `GET {URLS.licenseEndpoint}?key=…&type=gold` with `cache: "reload"` and an
 * `AbortSignal.timeout`. The endpoint wraps its verdict in page text, so the
 * first `{…}` JSON object in the body is what gets parsed. `fetch` is
 * injectable for tests.
 */

import type { LicenseClient, LicenseResult, LicenseVerdict } from "@core/auth/license-client";
import { TIMINGS } from "@core/constants/timings";
import { URLS } from "@core/constants/urls";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PhantomLicenseClientOptions {
	fetch?: FetchLike;
	endpoint?: string;
	timeoutMs?: number;
}

const VERDICTS: Readonly<Record<string, LicenseVerdict>> = {
	valid: "valid",
	iplimit: "ip_limit",
	invalid: "invalid",
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** First parseable `{…}` object in `text`, or `null`. */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
	let from = 0;
	for (;;) {
		const start = text.indexOf("{", from);
		if (start < 0) return null;
		let depth = 0;
		for (let i = start; i < text.length; i += 1) {
			const ch = text[i];
			if (ch === "{") depth += 1;
			else if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					try {
						const parsed: unknown = JSON.parse(text.slice(start, i + 1));
						if (isRecord(parsed)) return parsed;
					} catch {
						// not JSON — keep scanning from the next brace
					}
					break;
				}
			}
		}
		from = start + 1;
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

function readExpiresAt(body: Record<string, unknown>): number | undefined {
	const raw = body.expiresAt ?? body.expires;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export class PhantomLicenseClient implements LicenseClient {
	private readonly fetchImpl: FetchLike;
	private readonly endpoint: string;
	private readonly timeoutMs: number;

	constructor(options: PhantomLicenseClientOptions = {}) {
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.endpoint = options.endpoint ?? URLS.licenseEndpoint;
		this.timeoutMs = options.timeoutMs ?? TIMINGS.licenseValidateTimeoutMs;
	}

	async validate(key: string): Promise<LicenseResult> {
		const url = `${this.endpoint}?key=${encodeURIComponent(key)}&type=gold`;
		let text: string;
		let ok: boolean;
		let httpStatus: number;
		try {
			const response = await this.fetchImpl(url, {
				cache: "reload",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			ok = response.ok;
			httpStatus = response.status;
			text = await response.text();
		} catch (error) {
			return { status: "network_error", message: errorText(error) };
		}
		if (!ok) return { status: "network_error", message: `HTTP ${httpStatus}` };
		const body = extractFirstJsonObject(text);
		if (!body) return { status: "network_error", message: "no JSON object in response" };
		const raw = typeof body.status === "string" ? body.status.toLowerCase() : "";
		const verdict = VERDICTS[raw];
		if (!verdict) return { status: "invalid", message: `unexpected status "${String(body.status)}"` };
		const result: LicenseResult = { status: verdict };
		const expiresAt = readExpiresAt(body);
		if (expiresAt !== undefined) result.expiresAt = expiresAt;
		return result;
	}
}
