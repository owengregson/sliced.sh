// test/core/constants/registry.test.ts
import { describe, expect, it } from "bun:test";
import {
	ALARM_NAMES,
	LIMITS,
	LOCAL_KEYS,
	MSG,
	PORT_NAMES,
	SESSION_KEYS,
	TIMINGS,
} from "@core/constants";

describe("constants registry", () => {
	it("storage keys are namespaced and unique", () => {
		const all = [...Object.values(LOCAL_KEYS), ...Object.values(SESSION_KEYS)];
		expect(new Set(all).size).toBe(all.length);
		for (const k of all) expect(k.startsWith("sl::")).toBe(true);
	});
	it("message types are unique and namespaced", () => {
		const all = Object.values(MSG);
		expect(new Set(all).size).toBe(all.length);
		for (const m of all) expect(m.startsWith("sl:")).toBe(true);
	});
	it("ports and alarms are prefixed", () => {
		for (const p of Object.values(PORT_NAMES)) expect(p.startsWith("sl-")).toBe(true);
		for (const a of Object.values(ALARM_NAMES)) expect(a.startsWith("sl-")).toBe(true);
	});
	it("limits are ordered", () => {
		expect(LIMITS.eloMin).toBeLessThan(LIMITS.engineEloMin);
		expect(LIMITS.engineEloMax).toBeLessThan(LIMITS.eloMax);
		expect(TIMINGS.engineStopTimeoutMs).toBeLessThan(TIMINGS.engineReadyTimeoutMs);
	});
});
