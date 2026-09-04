// test/service/tts.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_KEYS } from "@core/constants";
import { speak, stop } from "@service/tts";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

describe("speak", () => {
	it("speaks with no voice when display.ttsVoice is null", async () => {
		await speak("e4");
		expect(sim.tts.calls).toHaveLength(1);
		expect(sim.tts.calls[0]?.utterance).toBe("e4");
		expect(sim.tts.calls[0]?.options.voiceName).toBeUndefined();
	});
	it("honours display.ttsVoice", async () => {
		sim.storage.data.local[LOCAL_KEYS.settings] = { display: { ttsVoice: "Sim British" } };
		await speak("Nf3");
		expect(sim.tts.calls[0]?.options).toMatchObject({ voiceName: "Sim British", enqueue: false });
	});
	it("stop cancels current speech", async () => {
		await speak("d4");
		await stop();
		expect(sim.tts.stops).toHaveLength(1);
		expect(sim.tts.speaking()).toBe(false);
	});
});
