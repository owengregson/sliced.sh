// test/service/update-check.test.ts — §12.2 "update available".
//
// The flag the panel routes on is written by exactly one thing, so the rules that matter are:
// a newer published version raises it (with the version the §4.8 copy names), an equal or older
// one lowers it, an unreachable site changes nothing either way, and an unchanged verdict does
// not touch storage — otherwise the six-hourly write would re-raise the interrupt the user
// already dismissed with "Later".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LicenseClient } from "@core/auth/license-client";
import { onStorageChanged } from "@core/chrome/storage";
import { ALARM_NAMES, LOCAL_KEYS } from "@core/constants";
import { TIMINGS } from "@core/constants/timings";
import { URLS } from "@core/constants/urls";
import { __resetServiceSystemsCache, bootstrapServiceSystems } from "@service/bootstrap";
import { wireServiceLifecycle } from "@service/lifecycle";
import {
	checkForUpdate,
	compareVersions,
	type FetchLike,
	isNewerVersion,
	isVersion,
	readPublishedVersion,
} from "@service/update-check";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;

beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
	__resetServiceSystemsCache();
});
afterEach(() => {
	__resetServiceSystemsCache();
});

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function serving(body: string, status = 200): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return new Response(body, { status });
		},
	};
}

const manifest = (version: unknown): string => JSON.stringify({ manifest_version: 3, version });

const stored = (): { flag: unknown; version: unknown } => ({
	flag: sim.storage.data.local[LOCAL_KEYS.updateAvailable],
	version: sim.storage.data.local[LOCAL_KEYS.updateVersion],
});

describe("version helpers", () => {
	it("accepts one to four dot-separated integers and nothing else", () => {
		expect(isVersion("2")).toBe(true);
		expect(isVersion("2.0.0")).toBe(true);
		expect(isVersion("2.0.0.1")).toBe(true);
		expect(isVersion("2.0.0.1.4")).toBe(false);
		expect(isVersion("2.0.0-beta")).toBe(false);
		expect(isVersion("v2.0.0")).toBe(false);
		expect(isVersion("")).toBe(false);
		expect(isVersion(2)).toBe(false);
	});

	it("compares component-wise, treating a missing component as 0", () => {
		expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
		expect(compareVersions("2.0", "2.0.0")).toBe(0);
		expect(compareVersions("2.0.1", "2.0.0")).toBe(1);
		expect(compareVersions("2.0.0", "2.0.1")).toBe(-1);
		expect(compareVersions("2.10.0", "2.9.0")).toBe(1); // not a string compare
		expect(compareVersions("10.0", "9.9.9")).toBe(1);
	});

	it("treats only a strictly newer, well-formed version as an update", () => {
		expect(isNewerVersion("2.1.0", "2.0.0")).toBe(true);
		expect(isNewerVersion("2.0.0", "2.0.0")).toBe(false);
		expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
		expect(isNewerVersion("next", "2.0.0")).toBe(false);
		expect(isNewerVersion("2.1.0", "test")).toBe(false); // the test build define
	});

	it("reads `version` out of a manifest body, or nothing", () => {
		expect(readPublishedVersion({ version: "2.1.0" })).toBe("2.1.0");
		expect(readPublishedVersion({ version: 2 })).toBeNull();
		expect(readPublishedVersion({})).toBeNull();
		expect(readPublishedVersion(null)).toBeNull();
		expect(readPublishedVersion("2.1.0")).toBeNull();
	});
});

describe("checkForUpdate", () => {
	it("asks the site's published manifest with no cache and a timeout", async () => {
		const { fetch, calls } = serving(manifest("2.0.0"));
		await checkForUpdate({ fetch, currentVersion: "2.0.0" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(URLS.websiteManifest);
		expect(URLS.websiteManifest).toBe(`${URLS.website}/manifest.json`);
		expect(calls[0]?.init?.cache).toBe("no-store");
		expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
		expect(TIMINGS.licenseValidateTimeoutMs).toBeGreaterThan(0);
	});

	it("raises the flag and records the version the §4.8 copy names", async () => {
		const { fetch } = serving(manifest("2.1.0"));
		const result = await checkForUpdate({ fetch, currentVersion: "2.0.0" });
		expect(result).toEqual({
			outcome: "available",
			latest: "2.1.0",
			current: "2.0.0",
			changed: true,
		});
		expect(stored()).toEqual({ flag: true, version: "2.1.0" });
	});

	it("lowers the flag and drops the version once the site is no longer ahead", async () => {
		Object.assign(sim.storage.data.local, {
			[LOCAL_KEYS.updateAvailable]: true,
			[LOCAL_KEYS.updateVersion]: "2.1.0",
		});
		const { fetch } = serving(manifest("2.1.0"));
		const result = await checkForUpdate({ fetch, currentVersion: "2.1.0" });
		expect(result.outcome).toBe("current");
		expect(result.changed).toBe(true);
		expect(stored()).toEqual({ flag: false, version: undefined });
	});

	it("does not write when the verdict is unchanged (a re-write would re-interrupt)", async () => {
		Object.assign(sim.storage.data.local, {
			[LOCAL_KEYS.updateAvailable]: true,
			[LOCAL_KEYS.updateVersion]: "2.1.0",
		});
		let changes = 0;
		const off = onStorageChanged("local", () => {
			changes += 1;
		});
		const { fetch } = serving(manifest("2.1.0"));
		const result = await checkForUpdate({ fetch, currentVersion: "2.0.0" });
		off();
		expect(result.changed).toBe(false);
		expect(changes).toBe(0);
		expect(stored()).toEqual({ flag: true, version: "2.1.0" });
	});

	it("re-records the version when the site moves on while the flag is already up", async () => {
		Object.assign(sim.storage.data.local, {
			[LOCAL_KEYS.updateAvailable]: true,
			[LOCAL_KEYS.updateVersion]: "2.1.0",
		});
		const { fetch } = serving(manifest("2.2.0"));
		const result = await checkForUpdate({ fetch, currentVersion: "2.0.0" });
		expect(result.changed).toBe(true);
		expect(stored()).toEqual({ flag: true, version: "2.2.0" });
	});

	it("leaves an announced update alone when the site cannot be reached (H.12)", async () => {
		Object.assign(sim.storage.data.local, {
			[LOCAL_KEYS.updateAvailable]: true,
			[LOCAL_KEYS.updateVersion]: "2.1.0",
		});
		const failures: Array<{ name: string; fetch: FetchLike }> = [
			{
				name: "network error",
				fetch: async () => {
					throw new Error("offline");
				},
			},
			{ name: "HTTP 503", fetch: serving("", 503).fetch },
			{ name: "not JSON", fetch: serving("<html>maintenance</html>").fetch },
			{ name: "no version", fetch: serving(JSON.stringify({ manifest_version: 3 })).fetch },
			{ name: "junk version", fetch: serving(manifest("soon™")).fetch },
		];
		for (const { name, fetch } of failures) {
			const result = await checkForUpdate({ fetch, currentVersion: "2.0.0" });
			expect(result, name).toEqual({
				outcome: "unreachable",
				latest: null,
				current: "2.0.0",
				changed: false,
			});
			expect(stored(), name).toEqual({ flag: true, version: "2.1.0" });
		}
	});

	it("does not invent an update out of an unreachable site either", async () => {
		const { fetch } = serving("", 404);
		await checkForUpdate({ fetch, currentVersion: "2.0.0" });
		expect(stored()).toEqual({ flag: undefined, version: undefined });
	});
});

describe("the licence alarm carries the poll (§12.2)", () => {
	const validClient = (): LicenseClient => ({ validate: async () => ({ status: "valid" }) });

	it("runs both checks on one alarm and neither hides the other's failure", async () => {
		const systems = bootstrapServiceSystems({ licenseClient: validClient() });
		let polls = 0;
		const lifecycle = wireServiceLifecycle({
			systems,
			updateCheck: async () => {
				polls += 1;
				throw new Error("site down");
			},
		});
		await systems.license.ensure();
		sim.chrome.alarms.create(ALARM_NAMES.licenseRevalidate, { when: sim.now() + 1 });
		await sim.time.advance(5);
		for (let i = 0; i < 10; i += 1) await sim.time.runMicrotasks();
		expect(polls).toBe(1);
		// A rejected poll is logged, not re-thrown: the licence revalidation still happened.
		expect(systems.license.getState().status).toBe("valid");
		lifecycle.dispose();
	});
});
