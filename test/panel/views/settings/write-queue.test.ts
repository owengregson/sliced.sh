import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { disabledFor } from "@panel/views/settings/dependencies";
import { orderedRangePatch } from "@panel/views/settings/write-queue";
import type { Settings } from "@typedefs/settings";

const withAutomation = (patch: Partial<Settings["automation"]>): Settings => ({
	...DEFAULT_SETTINGS,
	automation: { ...DEFAULT_SETTINGS.automation, ...patch },
});

describe("orderedRangePatch", () => {
	test("a patch without automation is returned as is", () => {
		const patch = { enabled: false };
		expect(orderedRangePatch(patch, DEFAULT_SETTINGS)).toBe(patch);
	});

	test("a minimum raised past the stored maximum drags the maximum with it", () => {
		const current = withAutomation({
			autoQueueSessionMinMinutes: 10,
			autoQueueSessionMaxMinutes: 20,
		});
		const patch = { automation: { autoQueueSessionMinMinutes: 30 } };
		expect(orderedRangePatch(patch, current).automation).toEqual({
			autoQueueSessionMinMinutes: 30,
			autoQueueSessionMaxMinutes: 30,
		});
		expect(patch.automation).toEqual({ autoQueueSessionMinMinutes: 30 });
	});

	test("a maximum lowered past the stored minimum drags the minimum with it", () => {
		const current = withAutomation({ autoQueueBreakMinMinutes: 10, autoQueueBreakMaxMinutes: 20 });
		const patch = { automation: { autoQueueBreakMaxMinutes: 5 } };
		expect(orderedRangePatch(patch, current).automation).toEqual({
			autoQueueBreakMinMinutes: 5,
			autoQueueBreakMaxMinutes: 5,
		});
	});

	test("a patch setting both ends is left alone", () => {
		const current = withAutomation({ autoQueueBreakMinMinutes: 10, autoQueueBreakMaxMinutes: 20 });
		const patch = { automation: { autoQueueBreakMinMinutes: 40, autoQueueBreakMaxMinutes: 30 } };
		expect(orderedRangePatch(patch, current).automation).toEqual(patch.automation);
	});
});

describe("disabledFor", () => {
	test("everything is disabled while locked", () => {
		expect(disabledFor("enabled", DEFAULT_SETTINGS, true)).toBe(true);
	});

	test("session and break ranges follow auto-queue", () => {
		const off = withAutomation({ autoQueue: false });
		const on = withAutomation({ autoQueue: true });
		expect(disabledFor("automation.autoQueueBreakMaxMinutes", off, false)).toBe(true);
		expect(disabledFor("automation.autoQueueSessionMinMinutes", on, false)).toBe(false);
	});

	test("forced-mate sounds need both move ratings and rating sounds", () => {
		const s = withAutomation({ moveQualityChips: true, moveRatingSounds: false });
		expect(disabledFor("automation.forcedMateSounds", s, false)).toBe(true);
	});
});
