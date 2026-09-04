// test/sim/tts.test.ts
import { describe, expect, it } from "bun:test";
import { ttsSpeak, ttsStop } from "@core/chrome/tts";
import { createSimulator } from "@test/sim";

describe("chrome.tts fake", () => {
	it("records speak calls with options and timestamps, delivers start/end events, records stop", async () => {
		const sim = createSimulator({ startAt: 5_000 });
		const prevChrome = (globalThis as Record<string, unknown>).chrome;
		(globalThis as Record<string, unknown>).chrome = sim.chrome;
		const events: string[] = [];
		await ttsSpeak("knight f3", { rate: 1.1, onEvent: (e) => void events.push(e.type) });
		await sim.time.advance(100);
		await ttsSpeak("bishop takes e5", { voiceName: "Sim British" });
		expect(sim.tts.calls.map((c) => [c.utterance, c.at])).toEqual([
			["knight f3", 5_000],
			["bishop takes e5", 5_100],
		]);
		expect(sim.tts.calls[1]?.options).toEqual({ voiceName: "Sim British" });
		expect(events).toEqual(["start", "end"]);
		await ttsStop();
		expect(sim.tts.stops).toEqual([5_100]);
		expect(sim.tts.speaking()).toBe(false);
		const voices = await sim.chrome.tts.getVoices();
		expect(voices.map((v) => v.voiceName)).toEqual(["Sim English", "Sim British"]);
		const viaCb = await new Promise<chrome.tts.TtsVoice[]>((r) => sim.chrome.tts.getVoices(r));
		expect(viaCb).toHaveLength(2);
		sim.tts.clear();
		expect(sim.tts.calls).toEqual([]);
		(globalThis as Record<string, unknown>).chrome = prevChrome;
	});
});
