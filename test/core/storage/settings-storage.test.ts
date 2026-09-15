// test/core/storage/settings-storage.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { FORCED_SETTING_VALUES, LIMITS, LOCAL_KEYS } from "@core/constants";
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
	it("keeps rating sounds opt-in and persists the preference independently of control sounds", async () => {
		expect(normalizeSettings({ automation: {} }).automation.moveRatingSounds).toBe(false);
		expect(
			normalizeSettings({ automation: { moveRatingSounds: "true" } }).automation.moveRatingSounds
		).toBe(false);
		await setSettings({ automation: { moveRatingSounds: true }, display: { uiSounds: false } });
		expect((await getSettings()).automation.moveRatingSounds).toBe(true);
		expect((await getSettings()).display.uiSounds).toBe(false);
	});
	it("returns defaults when nothing stored", async () => {
		expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
	});
	it("merges a nested partial and clamps elo", async () => {
		await setSettings({ strength: { targetElo: 9999 } });
		const s = await getSettings();
		expect(s.strength.targetElo).toBe(3800);
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
				execution: { style: stored, motorSpeed: 1.5, previewSelectScale: 0.5 },
			});
			expect("style" in (s.execution as unknown as Record<string, unknown>)).toBe(false);
			expect(s.execution.motorSpeed).toBe(1.5);
			expect(s.execution.previewSelectScale).toBe(0.5);
			expect(s.execution.verifyMoves).toBe(DEFAULT_SETTINGS.execution.verifyMoves);
			expect(s.execution.backend).toBe(DEFAULT_SETTINGS.execution.backend);
		}
		// and the shipped defaults never had it either
		expect("style" in (DEFAULT_SETTINGS.execution as unknown as Record<string, unknown>)).toBe(false);
	});

	// ── settings layout, 2026-09-13: every deleted or moved leaf still loads from an old shape ──
	describe("settings layout migrations (2026-09-13)", () => {
		const keys = (o: object): string[] => Object.keys(o);

		it("folds a stored `execution.previewSelects` into the rate slider: off → 0, auto keeps the rate", () => {
			const off = normalizeSettings({ execution: { previewSelects: "off", previewSelectScale: 1.5 } });
			expect(off.execution.previewSelectScale).toBe(0);
			expect(keys(off.execution)).not.toContain("previewSelects");
			const auto = normalizeSettings({
				execution: { previewSelects: "auto", previewSelectScale: 1.5 },
			});
			expect(auto.execution.previewSelectScale).toBe(1.5);
			expect(keys(auto.execution)).not.toContain("previewSelects");
			// A profile that never had the segment (or had garbage in it) keeps its rate.
			expect(
				normalizeSettings({ execution: { previewSelects: 3 } }).execution.previewSelectScale
			).toBe(DEFAULT_SETTINGS.execution.previewSelectScale);
			expect(keys(DEFAULT_SETTINGS.execution)).not.toContain("previewSelects");
		});

		it("drops a stored `display.pvCount`: the engine's `multiPv` is the one lines knob", () => {
			const s = normalizeSettings({ display: { pvCount: 2, evalBar: false }, engine: { multiPv: 6 } });
			expect(keys(s.display)).not.toContain("pvCount");
			expect(s.display.evalBar).toBe(false);
			expect(s.engine.multiPv).toBe(6);
			expect(keys(DEFAULT_SETTINGS.display)).not.toContain("pvCount");
		});

		it("forces `timing.respectBudget` on and `keybinds.global` off whatever was stored", () => {
			const s = normalizeSettings({
				timing: { respectBudget: false, speedScale: 2 },
				keybinds: { global: true },
			});
			expect(s.timing.respectBudget).toBe(true);
			expect(s.timing.speedScale).toBe(2);
			expect(s.keybinds.global).toBe(false);
		});

		it("reads `strength.blunderScale` again (the accuracy offset), clamped to its range", () => {
			expect(normalizeSettings({ strength: { blunderScale: 1.5 } }).strength.blunderScale).toBe(1.5);
			expect(normalizeSettings({ strength: { blunderScale: 9 } }).strength.blunderScale).toBe(
				LIMITS.blunderScaleMax
			);
			expect(normalizeSettings({ strength: { blunderScale: -1 } }).strength.blunderScale).toBe(
				LIMITS.blunderScaleMin
			);
			expect(normalizeSettings({ strength: { blunderScale: "x" } }).strength.blunderScale).toBe(
				DEFAULT_SETTINGS.strength.blunderScale
			);
		});

		it("reads the new booleans with their shipped defaults", () => {
			expect(DEFAULT_SETTINGS.automation.resignLostGames).toBe(true);
			expect(DEFAULT_SETTINGS.automation.moveQualityChips).toBe(true);
			const s = normalizeSettings({
				automation: { resignLostGames: false, moveQualityChips: false },
			});
			expect(s.automation.resignLostGames).toBe(false);
			expect(s.automation.moveQualityChips).toBe(false);
			expect(
				normalizeSettings({ automation: { resignLostGames: "no" } }).automation.resignLostGames
			).toBe(true);
		});
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
	it("forces the extension-decided keys regardless of what is stored (owner, 2026-09-12; 2026-09-13)", () => {
		// A stale profile, an import or a patch cannot resurrect a removed option: the normaliser
		// overwrites each forced leaf with `FORCED_SETTING_VALUES`, which equal the shipped defaults.
		const stored = normalizeSettings({
			strength: { persona: "blitz", selectionMode: "engine-elo" },
			timing: { respectBudget: false },
			execution: { calibrateFromMyMouse: true, backend: "native", keepDebuggerAttached: false },
			keybinds: { global: true },
			engine: { nnue: "big" },
		});
		expect(stored.strength.persona).toBe("balanced");
		expect(stored.strength.selectionMode).toBe("hybrid");
		expect(stored.timing.respectBudget).toBe(true);
		expect(stored.execution.calibrateFromMyMouse).toBe(false);
		expect(stored.execution.backend).toBe("cdp");
		expect(stored.execution.keepDebuggerAttached).toBe(true);
		expect(stored.keybinds.global).toBe(false);
		expect(stored.engine.nnue).toBe("auto");
		expect(stored).toEqual(DEFAULT_SETTINGS);
		expect(FORCED_SETTING_VALUES).toEqual({
			strength: {
				persona: DEFAULT_SETTINGS.strength.persona,
				selectionMode: DEFAULT_SETTINGS.strength.selectionMode,
			},
			timing: { respectBudget: DEFAULT_SETTINGS.timing.respectBudget },
			execution: {
				calibrateFromMyMouse: DEFAULT_SETTINGS.execution.calibrateFromMyMouse,
				backend: DEFAULT_SETTINGS.execution.backend,
				keepDebuggerAttached: DEFAULT_SETTINGS.execution.keepDebuggerAttached,
			},
			keybinds: { global: DEFAULT_SETTINGS.keybinds.global },
			engine: { nnue: DEFAULT_SETTINGS.engine.nnue },
		});
	});
	it("setSettings accepts a patch for a forced key but stores the forced value", async () => {
		await setSettings({
			strength: { persona: "aggressive", blunderScale: 2 },
			timing: { respectBudget: false },
			engine: { nnue: "small" },
		});
		const s = await getSettings();
		expect(s.strength.persona).toBe("balanced");
		// The accuracy offset is a real setting again (2026-09-13): the patch lands.
		expect(s.strength.blunderScale).toBe(2);
		expect(s.timing.respectBudget).toBe(true);
		expect(s.engine.nnue).toBe("auto");
	});
	it("clamps previewSelectScale to its spec range (0 is the Off position)", () => {
		expect(LIMITS.previewSelectScaleMin).toBe(0);
		expect(
			normalizeSettings({ execution: { previewSelectScale: 0 } }).execution.previewSelectScale
		).toBe(0);
		expect(
			normalizeSettings({ execution: { previewSelectScale: -3 } }).execution.previewSelectScale
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
		// `global` is forced off since 2026-09-13 (Chrome's own shortcuts always work).
		expect(s.keybinds.global).toBe(false);
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
