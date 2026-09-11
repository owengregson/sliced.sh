// test/core/storage/settings-storage.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { LIMITS, LOCAL_KEYS } from "@core/constants";
import {
	getSettings,
	normalizeSettings,
	onSettingsChanged,
	setSettings,
} from "@core/storage/settings-storage";
import { createSimulator } from "@test/sim";
import { DEFAULT_SETTINGS } from "@typedefs/settings";

beforeEach(() => {
	(globalThis as Record<string, unknown>).chrome = createSimulator().chrome;
});

describe("settings storage", () => {
	it("returns defaults when nothing stored", async () => {
		expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
	});
	it("merges a nested partial and clamps elo", async () => {
		await setSettings({ strength: { targetElo: 9999 } });
		const s = await getSettings();
		expect(s.strength.targetElo).toBe(3650);
		expect(s.strength.persona).toBe("balanced");
	});
});

describe("normalizeSettings", () => {
	it("returns defaults for garbage input", () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS);
	});
	it("replaces old per-game delay preferences with playing-session defaults", () => {
		const s = normalizeSettings({
			automation: {
				autoQueue: true,
				autoMove: true,
				autoQueueDelayEnabled: true,
				autoQueueDelayMaxMinutes: 3,
			},
		});
		expect(s.automation).toEqual({ ...DEFAULT_SETTINGS.automation, autoQueue: true, autoMove: true });
		expect("autoQueueDelayEnabled" in s.automation).toBe(false);
		expect("autoQueueDelayMaxMinutes" in s.automation).toBe(false);
	});
	it.each(["Session", "Break"] as const)(
		"normalizes the %s minute range to finite ordered integers",
		(kind) => {
			const lo = `autoQueue${kind}MinMinutes` as const;
			const hi = `autoQueue${kind}MaxMinutes` as const;
			const maxLimit =
				kind === "Session" ? LIMITS.autoQueueSessionMinutesMax : LIMITS.autoQueueBreakMinutesMax;
			const range = (min: unknown, max: unknown) =>
				normalizeSettings({ automation: { [lo]: min, [hi]: max } }).automation;
			expect(range(-10, 1000)[lo]).toBe(LIMITS.autoQueueMinutesMin);
			expect(range(-10, 1000)[hi]).toBe(maxLimit);
			expect(range(5.7, 8.2)[lo]).toBe(6);
			expect(range(5.7, 8.2)[hi]).toBe(8);
			expect(range(20, 5)[lo]).toBe(5);
			expect(range(20, 5)[hi]).toBe(20);
			for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
				expect(range(invalid, invalid)[lo]).toBe(DEFAULT_SETTINGS.automation[lo]);
				expect(range(invalid, invalid)[hi]).toBe(DEFAULT_SETTINGS.automation[hi]);
			}
		}
	);
	it("drops unknown keys at every level", () => {
		const s = normalizeSettings({
			bogus: 1,
			strength: { targetElo: 2000, extra: true },
		}) as unknown as Record<string, unknown>;
		expect("bogus" in s).toBe(false);
		expect("extra" in (s.strength as Record<string, unknown>)).toBe(false);
		expect((s.strength as { targetElo: number }).targetElo).toBe(2000);
	});
	it("tolerates a stored `execution.style` from a pre-drag-only profile: dropped, nothing else lost", () => {
		// Click-to-move was removed end to end, so the setting is gone. A profile stored by an older
		// build still carries it (`"click"` / `"auto"` / `"drag"`) and must normalise cleanly —
		// `execution` keeps every surviving field and the key itself does not come back.
		for (const stored of ["click", "auto", "drag"]) {
			const s = normalizeSettings({
				execution: { style: stored, motorSpeed: 1.5, previewSelects: "off" },
			});
			expect("style" in (s.execution as unknown as Record<string, unknown>)).toBe(false);
			expect(s.execution.motorSpeed).toBe(1.5);
			expect(s.execution.previewSelects).toBe("off");
			expect(s.execution.verifyMoves).toBe(DEFAULT_SETTINGS.execution.verifyMoves);
			expect(s.execution.backend).toBe(DEFAULT_SETTINGS.execution.backend);
		}
		// and the shipped defaults never had it either
		expect("style" in (DEFAULT_SETTINGS.execution as unknown as Record<string, unknown>)).toBe(false);
	});
	it("replaces invalid enum values and wrong-typed fields with defaults", () => {
		const s = normalizeSettings({
			enabled: "yes",
			strength: { persona: "reckless", selectionMode: 3 },
			timing: { profile: "warp", speedScale: "fast" },
			display: { theme: "neon", ttsVoice: 42 },
			engine: { nnue: "huge" },
			advanced: { logLevel: "verbose" },
		});
		expect(s.enabled).toBe(DEFAULT_SETTINGS.enabled);
		expect(s.strength.persona).toBe("balanced");
		expect(s.strength.selectionMode).toBe("hybrid");
		expect(s.timing.profile).toBe("natural");
		expect(s.timing.speedScale).toBe(1);
		expect(s.display.theme).toBe("dark");
		expect(s.display.ttsVoice).toBeNull();
		expect(s.engine.nnue).toBe("auto");
		expect(s.advanced.logLevel).toBe("info");
	});
	it("clamps engine limits and accepts threads auto or a bounded int", () => {
		const s = normalizeSettings({
			strength: { targetElo: -5 },
			engine: { multiPv: 99, depthCap: 1, hashMb: 100000, threads: 999 },
		});
		expect(s.strength.targetElo).toBe(LIMITS.eloMin);
		expect(s.engine.multiPv).toBe(LIMITS.multiPvMax);
		expect(s.engine.depthCap).toBe(LIMITS.depthMin);
		expect(s.engine.hashMb).toBe(LIMITS.hashMbMax);
		expect(s.engine.threads).toBe(LIMITS.threadsMax);
		expect(normalizeSettings({ engine: { threads: "auto" } }).engine.threads).toBe("auto");
		expect(normalizeSettings({ engine: { threads: "many" } }).engine.threads).toBe("auto");
		expect(normalizeSettings({ engine: { threads: 0 } }).engine.threads).toBe(1);
		expect(normalizeSettings({ engine: { threads: 2.7 } }).engine.threads).toBe(3);
	});
	it("clamps blunderScale and previewSelectScale to their spec ranges", () => {
		expect(normalizeSettings({ strength: { blunderScale: -50 } }).strength.blunderScale).toBe(
			LIMITS.blunderScaleMin
		);
		expect(normalizeSettings({ strength: { blunderScale: 7 } }).strength.blunderScale).toBe(
			LIMITS.blunderScaleMax
		);
		expect(normalizeSettings({ strength: { blunderScale: 1.5 } }).strength.blunderScale).toBe(1.5);
		expect(
			normalizeSettings({ execution: { previewSelectScale: 0 } }).execution.previewSelectScale
		).toBe(LIMITS.previewSelectScaleMin);
		expect(
			normalizeSettings({ execution: { previewSelectScale: 9 } }).execution.previewSelectScale
		).toBe(LIMITS.previewSelectScaleMax);
	});
	it("validates keybinds as whole objects", () => {
		const s = normalizeSettings({
			keybinds: {
				playMove: {
					key: "p",
					code: "KeyP",
					altKey: true,
					ctrlKey: false,
					metaKey: false,
					shiftKey: false,
				},
				disable: { key: 5 },
				global: true,
			},
		});
		expect(s.keybinds.playMove.key).toBe("p");
		expect(s.keybinds.playMove.altKey).toBe(true);
		expect(s.keybinds.disable).toEqual(DEFAULT_SETTINGS.keybinds.disable);
		expect(s.keybinds.global).toBe(true);
	});
	it("does not return the frozen default objects", () => {
		const s = normalizeSettings(undefined);
		expect(Object.isFrozen(s)).toBe(false);
		expect(s.strength).not.toBe(DEFAULT_SETTINGS.strength);
	});
});

describe("setSettings / onSettingsChanged", () => {
	it("preserves playing-session preferences through partial writes and disabling auto-queue", async () => {
		await setSettings({ automation: { autoQueue: true, autoQueueSessionMinMinutes: 30 } });
		await setSettings({ automation: { autoQueueBreakMaxMinutes: 12 } });
		await setSettings({ automation: { autoQueue: false } });
		expect((await getSettings()).automation).toEqual({
			...DEFAULT_SETTINGS.automation,
			autoQueue: false,
			autoQueueSessionMinMinutes: 30,
			autoQueueBreakMaxMinutes: 12,
		});
	});
	it("read-merge-writes so unrelated sections survive", async () => {
		await setSettings({ display: { theme: "light" } });
		await setSettings({ engine: { multiPv: 2 } });
		const s = await getSettings();
		expect(s.display.theme).toBe("light");
		expect(s.engine.multiPv).toBe(2);
	});
	it("notifies subscribers with normalised settings and unsubscribes", async () => {
		const seen: number[] = [];
		const off = onSettingsChanged((s) => seen.push(s.strength.targetElo));
		await setSettings({ strength: { targetElo: 1800 } });
		expect(seen).toEqual([1800]);
		off();
		await setSettings({ strength: { targetElo: 1900 } });
		expect(seen).toEqual([1800]);
	});
	it("ignores changes to other keys", async () => {
		let calls = 0;
		const off = onSettingsChanged(() => calls++);
		await new Promise<void>((r) => chrome.storage.local.set({ [LOCAL_KEYS.licenseKey]: "k" }, r));
		expect(calls).toBe(0);
		off();
	});
});
