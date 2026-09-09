// test/core/auth/phantom-license-client.test.ts
import { describe, expect, it } from "bun:test";
import {
	extractFirstJsonObject,
	type FetchLike,
	PhantomLicenseClient,
} from "@core/auth/phantom-license-client";
import { LICENSE_ENDPOINT, TIMINGS } from "@core/constants";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function fetchReturning(body: string, status = 200): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, init });
		return new Response(body, { status });
	};
	return { fetch, calls };
}

describe("extractFirstJsonObject", () => {
	it("returns the first {…} object embedded in text", () => {
		expect(extractFirstJsonObject('<html>noise {"status":"valid","x":1} trailing')).toEqual({
			status: "valid",
			x: 1,
		});
	});
	it("returns null when there is no parseable object", () => {
		expect(extractFirstJsonObject("nothing here")).toBeNull();
		expect(extractFirstJsonObject("{not json}")).toBeNull();
		expect(extractFirstJsonObject("[1,2]")).toBeNull();
	});
	it("skips a broken object and finds a later one", () => {
		expect(extractFirstJsonObject('{oops} then {"status":"invalid"}')).toEqual({
			status: "invalid",
		});
	});
});

describe("PhantomLicenseClient.validate", () => {
	it("requests the endpoint with the encoded key, type=gold, cache reload and a timeout", async () => {
		const { fetch, calls } = fetchReturning('{"status":"valid"}');
		const client = new PhantomLicenseClient({ fetch });
		await client.validate("a b&c");
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(`${LICENSE_ENDPOINT}?key=a%20b%26c&type=gold`);
		expect(call.init?.cache).toBe("reload");
		expect(call.init?.signal).toBeInstanceOf(AbortSignal);
		expect(TIMINGS.licenseValidateTimeoutMs).toBeGreaterThan(0);
	});
	it("maps valid / iplimit / invalid to the LicenseResult verdicts", async () => {
		for (const [raw, status] of [
			["valid", "valid"],
			["iplimit", "ip_limit"],
			["invalid", "invalid"],
		] as const) {
			const { fetch } = fetchReturning(`Response: {"status":"${raw}"} </body>`);
			const result = await new PhantomLicenseClient({ fetch }).validate("k");
			expect(result.status).toBe(status);
		}
	});
	it("allows an empty key", async () => {
		const { fetch, calls } = fetchReturning('{"status":"invalid"}');
		await new PhantomLicenseClient({ fetch }).validate("");
		expect(calls[0]?.url).toBe(`${LICENSE_ENDPOINT}?key=&type=gold`);
	});
	it("passes a numeric expiresAt through", async () => {
		const { fetch } = fetchReturning('{"status":"valid","expiresAt":1700000000000}');
		const result = await new PhantomLicenseClient({ fetch }).validate("k");
		expect(result).toEqual({ status: "valid", expiresAt: 1_700_000_000_000 });
	});
	it("maps an unknown verdict to invalid with a message", async () => {
		const { fetch } = fetchReturning('{"status":"banana"}');
		const result = await new PhantomLicenseClient({ fetch }).validate("k");
		expect(result.status).toBe("invalid");
		expect(result.message).toContain("banana");
	});
	it("maps a thrown fetch (network / timeout) to network_error", async () => {
		const fetch: FetchLike = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};
		const result = await new PhantomLicenseClient({ fetch }).validate("k");
		expect(result.status).toBe("network_error");
		expect(result.message).toContain("timed out");
	});
	it("maps a non-2xx response and a body without JSON to network_error", async () => {
		const { fetch: f500 } = fetchReturning("Internal error", 500);
		expect((await new PhantomLicenseClient({ fetch: f500 }).validate("k")).status).toBe(
			"network_error"
		);
		const { fetch: fNoJson } = fetchReturning("<html>maintenance</html>");
		expect((await new PhantomLicenseClient({ fetch: fNoJson }).validate("k")).status).toBe(
			"network_error"
		);
	});
});
