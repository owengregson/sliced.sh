// test/service/lifecycle.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LicenseClient } from "@core/auth/license-client";
import { ALARM_NAMES, DEFAULT_SETTINGS, LIMITS, LOCAL_KEYS } from "@core/constants";
import { getSettings } from "@core/storage/settings-storage";
import { __resetServiceSystemsCache, bootstrapServiceSystems } from "@service/bootstrap";
import {
	LEGACY_KEYS,
	legacyEloToTargetElo,
	legacyMaxWaitToSpeedScale,
	migrateLegacySettings,
	wireServiceLifecycle,
} from "@service/lifecycle";
import { createSimulator, type Simulator } from "@test/sim";
import type { Settings } from "@typedefs/settings";

let sim: Simulator;
const validClient = (): LicenseClient & { calls: number } => {
	const client: LicenseClient & { calls: number } = {
		calls: 0,
		async validate() {
			client.calls += 1;
			return { status: "valid" as const };
		},
	};
	return client;
};

beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
	__resetServiceSystemsCache();
});
afterEach(() => {
	__resetServiceSystemsCache();
});

const settle = () => sim.time.runMicrotasks();

describe("legacy value mapping", () => {
	it("maps legacy elo 1–20 onto the engine elo range, rounded to 10", () => {
		expect(legacyEloToTargetElo(1)).toBe(LIMITS.engineEloMin);
		expect(legacyEloToTargetElo(20)).toBe(LIMITS.engineEloMax);
		expect(legacyEloToTargetElo(6)).toBe(1810); // 1320 + 5 * 98.42 = 1812.1 → 1810
		expect(legacyEloToTargetElo(10)).toBe(2210); // 1320 + 9 * 98.42 = 2205.8 → 2210
		expect(legacyEloToTargetElo(0)).toBe(LIMITS.engineEloMin);
		expect(legacyEloToTargetElo(99)).toBe(LIMITS.engineEloMax);
		expect(legacyEloToTargetElo(Number.NaN)).toBeNull();
	});
	it("maps the legacy maxWaitTime (s) onto timing.speedScale around the legacy default", () => {
		expect(legacyMaxWaitToSpeedScale(4)).toBe(1);
		expect(legacyMaxWaitToSpeedScale(8)).toBeCloseTo(Math.exp(0.5), 2);
		expect(legacyMaxWaitToSpeedScale(1)).toBeCloseTo(Math.exp(-0.5), 2);
		expect(legacyMaxWaitToSpeedScale(6)).toBeCloseTo(1.5, 2);
		expect(legacyMaxWaitToSpeedScale(-3)).toBeCloseTo(Math.exp(-0.5), 2);
		expect(legacyMaxWaitToSpeedScale(Number.NaN)).toBeNull();
	});
});

describe("migrateLegacySettings", () => {
	it("maps every 1.x key into Settings and the license key, then removes the legacy keys", async () => {
		Object.assign(sim.storage.data.local, {
			extensionActive: true,
			highlightMoves: true,
			elo: 6,
			depthValue: 12,
			maxWaitTime: 6,
			automove: true,
			autoPlayNewGame: true,
			key: "GOLD-123",
			moveKeybind: "Space",
			exitKeybind: "KeyA",
			ttsKeybind: "Digit3",
			unrelated: "keep me",
		});
		const result = await migrateLegacySettings();
		expect(result.migrated).toBe(true);
		const s = await getSettings();
		expect(s.enabled).toBe(true);
		expect(s.automation.highlightMoves).toBe(true);
		expect(s.strength.targetElo).toBe(1810);
		expect(s.engine.depthCap).toBe(12);
		expect(s.timing.speedScale).toBeCloseTo(1.5, 2);
		expect(s.automation.autoMove).toBe(true);
		expect(s.automation.autoQueue).toBe(true);
		expect(s.keybinds.playMove).toEqual({ ...DEFAULT_SETTINGS.keybinds.playMove });
		expect(s.keybinds.disable).toEqual({
			key: "a",
			code: "KeyA",
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
		});
		expect(s.keybinds.speakMove).toMatchObject({ key: "3", code: "Digit3" });
		// untouched sections keep their defaults
		expect(s.strength.persona).toBe(DEFAULT_SETTINGS.strength.persona);
		expect(s.display).toEqual(DEFAULT_SETTINGS.display);
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBe("GOLD-123");
		for (const k of LEGACY_KEYS) expect(k in sim.storage.data.local).toBe(false);
		expect(sim.storage.data.local.unrelated).toBe("keep me");
	});
	it("ignores malformed legacy values and is a no-op without legacy keys", async () => {
		Object.assign(sim.storage.data.local, {
			extensionActive: "yes",
			elo: "high",
			depthValue: 999,
			maxWaitTime: null,
			key: "",
			moveKeybind: 42,
		});
		const first = await migrateLegacySettings();
		expect(first.migrated).toBe(true);
		const s = await getSettings();
		expect(s.enabled).toBe(DEFAULT_SETTINGS.enabled);
		expect(s.strength.targetElo).toBe(DEFAULT_SETTINGS.strength.targetElo);
		expect(s.engine.depthCap).toBe(LIMITS.depthMax);
		expect(s.timing.speedScale).toBe(DEFAULT_SETTINGS.timing.speedScale);
		expect(s.keybinds.playMove).toEqual({ ...DEFAULT_SETTINGS.keybinds.playMove });
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBeUndefined();
		const second = await migrateLegacySettings();
		expect(second.migrated).toBe(false);
	});
	it("does not clobber v2 settings already present", async () => {
		sim.storage.data.local[LOCAL_KEYS.settings] = {
			...DEFAULT_SETTINGS,
			strength: { ...DEFAULT_SETTINGS.strength, persona: "blitz" },
		} satisfies Settings;
		Object.assign(sim.storage.data.local, { elo: 20 });
		await migrateLegacySettings();
		const s = await getSettings();
		expect(s.strength.persona).toBe("blitz");
		expect(s.strength.targetElo).toBe(LIMITS.engineEloMax);
	});
});

describe("wireServiceLifecycle", () => {
	it("onInstalled(install) stamps installedAt, writes default settings and validates the license", async () => {
		const client = validClient();
		const systems = bootstrapServiceSystems({ licenseClient: client });
		const lifecycle = wireServiceLifecycle({ systems, now: sim.now });
		sim.runtime.fireOnInstalled({ reason: "install" });
		await settle();
		expect(sim.storage.data.local[LOCAL_KEYS.installedAt]).toBe(sim.now());
		expect(sim.storage.data.local[LOCAL_KEYS.settings]).toEqual(DEFAULT_SETTINGS);
		expect(client.calls).toBe(1);
		lifecycle.dispose();
	});
	it("onInstalled(update from 1.x) runs the legacy migration; from 2.x it does not", async () => {
		const systems = bootstrapServiceSystems({ licenseClient: validClient() });
		const lifecycle = wireServiceLifecycle({ systems });
		Object.assign(sim.storage.data.local, { elo: 20, extensionActive: true });
		sim.runtime.fireOnInstalled({ reason: "update", previousVersion: "2.0.0" });
		await settle();
		expect("elo" in sim.storage.data.local).toBe(true);
		sim.runtime.fireOnInstalled({ reason: "update", previousVersion: "1.9.3" });
		await settle();
		expect("elo" in sim.storage.data.local).toBe(false);
		expect((await getSettings()).strength.targetElo).toBe(LIMITS.engineEloMax);
		expect(sim.storage.data.local[LOCAL_KEYS.installedAt]).toBeUndefined();
		lifecycle.dispose();
	});
	it("onStartup validates the license; the alarm dispatcher routes by name", async () => {
		const client = validClient();
		const systems = bootstrapServiceSystems({ licenseClient: client });
		const lifecycle = wireServiceLifecycle({ systems });
		sim.runtime.fireOnStartup();
		await settle();
		expect(client.calls).toBe(1);
		let flushed = 0;
		lifecycle.setAlarmHandler(ALARM_NAMES.timingLogFlush, () => {
			flushed += 1;
		});
		sim.chrome.alarms.create(ALARM_NAMES.timingLogFlush, { when: sim.now() + 1 });
		sim.chrome.alarms.create(ALARM_NAMES.licenseRevalidate, { when: sim.now() + 1 });
		await sim.time.advance(5);
		await settle();
		expect(flushed).toBe(1);
		expect(client.calls).toBe(2);
		lifecycle.dispose();
	});
	it("commands are forwarded to the active tab's session when a registry exists, else logged", async () => {
		const systems = bootstrapServiceSystems({ licenseClient: validClient() });
		const lifecycle = wireServiceLifecycle({ systems });
		expect(() => sim.commands.trigger("play-move")).not.toThrow();
		const received: string[] = [];
		systems.sessions = {
			forActiveTab: async () => ({ onCommand: (c: string) => void received.push(c) }),
			dispose: () => {},
		};
		sim.commands.trigger("play-move");
		await settle();
		expect(received).toEqual(["play-move"]);
		lifecycle.dispose();
		sim.commands.trigger("play-move");
		await settle();
		expect(received).toEqual(["play-move"]);
	});
});
