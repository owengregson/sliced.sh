// test/service/license-gate.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import type { LicenseClient, LicenseResult } from "@core/auth/license-client";
import {
	ALARM_CADENCE_MINUTES,
	ALARM_NAMES,
	LICENSE_FORCE_VALID,
	LOCAL_KEYS,
} from "@core/constants";
import { LicenseGate } from "@service/license-gate";
import { createSimulator, type Simulator } from "@test/sim";
import type { LicenseState } from "@typedefs/settings";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

function clientReturning(...results: LicenseResult[]): LicenseClient & { calls: string[] } {
	const calls: string[] = [];
	let i = 0;
	return {
		calls,
		async validate(key) {
			calls.push(key);
			const r = results[Math.min(i, results.length - 1)]!;
			i += 1;
			return r;
		},
	};
}

const stored = (): LicenseState | undefined =>
	sim.storage.data.local[LOCAL_KEYS.licenseState] as LicenseState | undefined;

describe("LicenseGate (force-valid, the build/test default)", () => {
	it("the test build is force-valid", () => {
		expect(LICENSE_FORCE_VALID).toBe(true);
	});
	it.each([
		[{ status: "valid" } as LicenseResult, "valid"],
		[{ status: "ip_limit" } as LicenseResult, "ip_limit"],
		[{ status: "invalid" } as LicenseResult, "invalid"],
		[{ status: "network_error", message: "offline" } as LicenseResult, "network_error"],
	])("records the raw verdict %j but the effective status is valid", async (result, raw) => {
		const gate = new LicenseGate({ client: clientReturning(result), now: sim.now });
		const state = await gate.ensure();
		expect(state.status).toBe("valid");
		expect(state.rawStatus).toBe(raw as LicenseState["status"]);
		expect(state.checkedAt).toBe(sim.now());
		expect(gate.isUnlocked()).toBe(true);
		expect(stored()).toEqual(state);
	});
	it("validates with the stored key, or an empty string when none is stored", async () => {
		const client = clientReturning({ status: "valid" });
		await new LicenseGate({ client }).ensure();
		expect(client.calls).toEqual([""]);
		sim.storage.data.local[LOCAL_KEYS.licenseKey] = "GOLD-1";
		const client2 = clientReturning({ status: "valid" });
		await new LicenseGate({ client: client2 }).ensure();
		expect(client2.calls).toEqual(["GOLD-1"]);
	});
	it("ensure() validates once per gate and dedupes concurrent callers", async () => {
		const client = clientReturning({ status: "valid" });
		const gate = new LicenseGate({ client });
		await Promise.all([gate.ensure(), gate.ensure(), gate.ensure()]);
		await gate.ensure();
		expect(client.calls).toHaveLength(1);
		await gate.revalidate();
		expect(client.calls).toHaveLength(2);
	});
	it("arms the 6 h revalidation alarm once", async () => {
		const gate = new LicenseGate({ client: clientReturning({ status: "valid" }) });
		await gate.ensure();
		await gate.revalidate();
		const alarms = sim.alarms.list().filter((a) => a.name === ALARM_NAMES.licenseRevalidate);
		expect(alarms).toHaveLength(1);
		expect(alarms[0]?.periodInMinutes).toBe(ALARM_CADENCE_MINUTES.licenseRevalidate);
	});
	it("login stores the key and revalidates; logout clears the key", async () => {
		const client = clientReturning({ status: "valid" });
		const gate = new LicenseGate({ client });
		const state = await gate.login("KEY-9");
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBe("KEY-9");
		expect(client.calls).toEqual(["KEY-9"]);
		expect(state.status).toBe("valid");
		await gate.logout();
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBeUndefined();
		expect(client.calls).toEqual(["KEY-9", ""]);
	});
	it("isUnlocked() is false before ensure() and reads the persisted state after", async () => {
		sim.storage.data.local[LOCAL_KEYS.licenseState] = {
			status: "valid",
			checkedAt: 5,
		} satisfies LicenseState;
		const gate = new LicenseGate({ client: clientReturning({ status: "invalid" }) });
		expect(gate.isUnlocked()).toBe(false);
		expect(gate.getState().status).toBe("unknown");
		await gate.ensure();
		expect(gate.isUnlocked()).toBe(true);
	});
});

describe("LicenseGate (enforcing)", () => {
	it("the raw verdict is the effective status", async () => {
		for (const status of ["valid", "ip_limit", "invalid", "network_error"] as const) {
			sim = createSimulator();
			(globalThis as Record<string, unknown>).chrome = sim.chrome;
			const gate = new LicenseGate({ client: clientReturning({ status }), forceValid: false });
			const state = await gate.ensure();
			expect(state.status).toBe(status);
			expect(state.rawStatus).toBe(status);
			expect(gate.isUnlocked()).toBe(status === "valid");
		}
	});
	it("a previously valid state survives a network error", async () => {
		const previous: LicenseState = {
			status: "valid",
			rawStatus: "valid",
			checkedAt: 1_000,
			expiresAt: 9_999,
		};
		sim.storage.data.local[LOCAL_KEYS.licenseState] = previous;
		const gate = new LicenseGate({
			client: clientReturning({ status: "network_error", message: "offline" }),
			forceValid: false,
		});
		const state = await gate.ensure();
		expect(state.status).toBe("valid");
		expect(state.rawStatus).toBe("network_error");
		expect(state.checkedAt).toBe(1_000);
		expect(state.expiresAt).toBe(9_999);
		expect(state.message).toBe("offline");
		expect(gate.isUnlocked()).toBe(true);
		expect(stored()?.status).toBe("valid");
	});
	it("a network error with no prior valid state is recorded as network_error", async () => {
		const gate = new LicenseGate({
			client: clientReturning({ status: "network_error" }),
			forceValid: false,
		});
		expect((await gate.ensure()).status).toBe("network_error");
		expect(gate.isUnlocked()).toBe(false);
	});
	it("a definitive invalid verdict does overwrite a valid state", async () => {
		sim.storage.data.local[LOCAL_KEYS.licenseState] = {
			status: "valid",
			checkedAt: 1,
		} satisfies LicenseState;
		const gate = new LicenseGate({
			client: clientReturning({ status: "invalid" }),
			forceValid: false,
		});
		expect((await gate.ensure()).status).toBe("invalid");
		expect(gate.isUnlocked()).toBe(false);
	});
	it("a rejected client call is treated as a network error", async () => {
		sim.storage.data.local[LOCAL_KEYS.licenseState] = {
			status: "valid",
			checkedAt: 1,
		} satisfies LicenseState;
		const client: LicenseClient = {
			validate: async () => {
				throw new Error("boom");
			},
		};
		const gate = new LicenseGate({ client, forceValid: false });
		const state = await gate.ensure();
		expect(state.status).toBe("valid");
		expect(state.rawStatus).toBe("network_error");
		expect(state.message).toBe("boom");
	});
});
