// test/service/lifecycle.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LicenseClient } from "@core/auth/license-client";
import { ALARM_NAMES, DEFAULT_SETTINGS, LIMITS, LOCAL_KEYS } from "@core/constants";
import { getSettings } from "@core/storage/settings-storage";
import { __resetServiceSystemsCache, bootstrapServiceSystems } from "@service/bootstrap";
import {
	LEGACY_KEYS,
	legacyCodeToKeybind,
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
	it("coerces the popup's string slider values (event.target.value)", () => {
		expect(legacyEloToTargetElo("14")).toBe(legacyEloToTargetElo(14));
		expect(legacyEloToTargetElo(" 20 ")).toBe(LIMITS.engineEloMax);
		expect(legacyEloToTargetElo("high")).toBeNull();
		expect(legacyEloToTargetElo("")).toBeNull();
		expect(legacyMaxWaitToSpeedScale("4")).toBe(1);
		expect(legacyMaxWaitToSpeedScale("6")).toBe(legacyMaxWaitToSpeedScale(6));
		expect(legacyMaxWaitToSpeedScale("soon")).toBeNull();
	});
	it("normalises legacy keybinds: codes as captured, bare default letters/digits to codes", () => {
		expect(legacyCodeToKeybind("Space")).toMatchObject({ key: " ", code: "Space" });
		expect(legacyCodeToKeybind("KeyA")).toMatchObject({ key: "a", code: "KeyA" });
		expect(legacyCodeToKeybind("A")).toMatchObject({ key: "a", code: "KeyA" });
		expect(legacyCodeToKeybind("w")).toMatchObject({ key: "w", code: "KeyW" });
		expect(legacyCodeToKeybind("3")).toMatchObject({ key: "3", code: "Digit3" });
		expect(legacyCodeToKeybind("ShiftLeft")).toMatchObject({ key: "ShiftLeft", code: "ShiftLeft" });
		expect(legacyCodeToKeybind("")).toBeNull();
		expect(legacyCodeToKeybind(42)).toBeNull();
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
	it("migrates the shapes the 1.x popup actually wrote: string sliders, boolean toggles, bare default keybinds", async () => {
		// popup.js: sliders store `event.target.value` (strings), toggles `event.target.checked`;
		// background.js seeds the defaults `exitKeybind: "A"`, `ttsKeybind: "W"`.
		Object.assign(sim.storage.data.local, {
			extensionActive: false,
			highlightMoves: "false",
			elo: "14",
			depthValue: "18",
			maxWaitTime: "2",
			automove: "true",
			autoPlayNewGame: false,
			key: "  GOLD-STR  ",
			moveKeybind: "Space",
			exitKeybind: "A",
			ttsKeybind: "W",
		});
		const result = await migrateLegacySettings();
		expect(result).toMatchObject({ migrated: true, keyImported: true });
		const s = await getSettings();
		expect(s.enabled).toBe(false);
		expect(s.automation.highlightMoves).toBe(false);
		expect(s.automation.autoMove).toBe(true);
		expect(s.automation.autoQueue).toBe(false);
		expect(s.strength.targetElo).toBe(2600); // legacyEloToTargetElo(14)
		expect(s.engine.depthCap).toBe(18);
		expect(s.timing.speedScale).toBeCloseTo(Math.exp(-0.5), 2);
		expect(s.keybinds.playMove).toMatchObject({ key: " ", code: "Space" });
		expect(s.keybinds.disable).toMatchObject({ key: "a", code: "KeyA", shiftKey: false });
		expect(s.keybinds.speakMove).toMatchObject({ key: "w", code: "KeyW" });
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBe("GOLD-STR");
		for (const k of LEGACY_KEYS) expect(k in sim.storage.data.local).toBe(false);
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
		expect(first).toMatchObject({ migrated: true, keyImported: false });
		const s = await getSettings();
		expect(s.enabled).toBe(DEFAULT_SETTINGS.enabled);
		expect(s.strength.targetElo).toBe(DEFAULT_SETTINGS.strength.targetElo);
		expect(s.engine.depthCap).toBe(LIMITS.depthMax);
		expect(s.timing.speedScale).toBe(DEFAULT_SETTINGS.timing.speedScale);
		expect(s.keybinds.playMove).toEqual({ ...DEFAULT_SETTINGS.keybinds.playMove });
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBeUndefined();
		const second = await migrateLegacySettings();
		expect(second).toEqual({ migrated: false, keyImported: false, settings: null });
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

describe("bootstrapServiceSystems", () => {
	it("throws when options are passed after the singleton exists", () => {
		bootstrapServiceSystems({ licenseClient: validClient() });
		expect(() => bootstrapServiceSystems()).not.toThrow();
		expect(() => bootstrapServiceSystems({ forceValid: false })).toThrow("already bootstrapped");
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
	it("validates a key imported by the migration, even while the boot-time ensure() is in flight", async () => {
		const client = validClient();
		const keys: string[] = [];
		const original = client.validate.bind(client);
		client.validate = async (key) => {
			keys.push(key);
			return original(key);
		};
		const systems = bootstrapServiceSystems({ licenseClient: client });
		const lifecycle = wireServiceLifecycle({ systems });
		Object.assign(sim.storage.data.local, { key: "GOLD-OLD", elo: "9" });
		void systems.license.ensure(); // what service-worker.ts does at boot (empty key)
		sim.runtime.fireOnInstalled({ reason: "update", previousVersion: "1.4.0" });
		for (let i = 0; i < 10; i += 1) await settle();
		expect(keys).toEqual(["", "GOLD-OLD"]);
		expect(systems.license.getState().rawStatus).toBe("valid");
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBe("GOLD-OLD");
		lifecycle.dispose();
	});
	it("does not revalidate after an update that imported no key", async () => {
		const client = validClient();
		const systems = bootstrapServiceSystems({ licenseClient: client });
		const lifecycle = wireServiceLifecycle({ systems });
		Object.assign(sim.storage.data.local, { elo: "9", key: "" });
		sim.runtime.fireOnInstalled({ reason: "update", previousVersion: "1.4.0" });
		for (let i = 0; i < 10; i += 1) await settle();
		expect(client.calls).toBe(1);
		lifecycle.dispose();
	});
	it("a rejected license revalidation from the alarm is caught by the dispatcher", async () => {
		const client = validClient();
		const systems = bootstrapServiceSystems({ licenseClient: client });
		const lifecycle = wireServiceLifecycle({ systems });
		await systems.license.ensure();
		sim.chrome.alarms.create(ALARM_NAMES.licenseRevalidate, { when: sim.now() + 1 });
		sim.storage.failNextWith("quota exceeded");
		await sim.time.advance(5);
		for (let i = 0; i < 10; i += 1) await settle();
		// the storage read failed before the client was reached; the rejection was caught
		// by the dispatcher (an unhandled rejection would fail this test file)
		expect(client.calls).toBe(1);
		await systems.license.revalidate();
		expect(client.calls).toBe(2);
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
