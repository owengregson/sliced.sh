// test/core/timing/timing-log.test.ts — §8.6 ring buffer over LOCAL_KEYS.timingLog.
import { beforeEach, describe, expect, it } from "bun:test";
import { chromeLocalGet } from "@core/chrome/storage";
import { LIMITS } from "@core/constants/limits";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { buildTimingLogEntry, TimingLogWriter } from "@core/timing/timing-log";
import { createSimulator } from "@test/sim";

beforeEach(() => {
	(globalThis as Record<string, unknown>).chrome = createSimulator().chrome;
});

function entry(ply: number) {
	return buildTimingLogEntry({
		gameId: "g1",
		ply,
		mode: "normal",
		plannedMs: 1000 + ply,
		alloc: 3,
		clockMs: 100_000,
		comp: 1,
		eps: 0.1,
		terms: [
			["a", 0.1],
			["b", -0.5],
			["c", 0.3],
			["d", 0.05],
			["e", -0.2],
			["f", 0.4],
		],
		persona: "balanced",
	});
}

describe("timing log", () => {
	it("builds an entry with the top-5 |terms| and a null actualMs", () => {
		const e = entry(1);
		expect(e.actualMs).toBeNull();
		expect(e.topTerms.length).toBe(5);
		expect(e.topTerms[0]).toEqual(["b", -0.5]);
		expect(e.topTerms.map(([n]) => n)).not.toContain("d");
	});
	it("keeps at most LIMITS.timingLogMax entries and persists them", async () => {
		const w = new TimingLogWriter();
		for (let i = 0; i < LIMITS.timingLogMax + 25; i++) w.append(entry(i));
		expect(w.entries().length).toBe(LIMITS.timingLogMax);
		expect(w.entries()[0]?.ply).toBe(25);
		await w.flush();
		const stored = await chromeLocalGet(LOCAL_KEYS.timingLog);
		expect(stored?.length).toBe(LIMITS.timingLogMax);
		expect(stored?.[stored.length - 1]?.ply).toBe(LIMITS.timingLogMax + 24);
	});
	it("records the realised time and loads what was stored", async () => {
		const w = new TimingLogWriter();
		w.append(entry(3));
		w.markActual("g1", 3, 1234);
		expect(w.entries()[0]?.actualMs).toBe(1234);
		await w.flush();
		const w2 = new TimingLogWriter();
		await w2.load();
		expect(w2.entries()).toEqual(w.entries());
		w2.dispose();
	});
	it("flush is a no-op when nothing changed", async () => {
		const w = new TimingLogWriter();
		expect(await w.flush()).toBe(false);
		w.append(entry(0));
		expect(await w.flush()).toBe(true);
		expect(await w.flush()).toBe(false);
	});
});
