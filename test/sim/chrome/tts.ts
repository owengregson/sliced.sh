// test/sim/chrome/tts.ts
/**
 * `chrome.tts`: records every `speak` (with the virtual-clock timestamp) and
 * `stop`; an `onEvent` option receives `start` then `end` on a microtask.
 * `getVoices` returns two canned voices.
 */

import type { Bus } from "@test/sim/contexts/bus";
import type { TtsCallRecord } from "@test/sim/types";

const VOICES: chrome.tts.TtsVoice[] = [
	{ voiceName: "Sim English", lang: "en-US", remote: false, eventTypes: ["start", "end"] },
	{ voiceName: "Sim British", lang: "en-GB", remote: false, eventTypes: ["start", "end"] },
];

export function createTtsSubsystem(bus: Bus) {
	const calls: TtsCallRecord[] = [];
	const stops: number[] = [];
	let speaking = false;

	const api = {
		speak(utterance: string, ...rest: unknown[]) {
			// (utterance, cb?) | (utterance, options, cb?)
			const callback = typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1] : undefined;
			const options = (
				typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}
			) as chrome.tts.TtsOptions;
			calls.push({ utterance, options: { ...options }, at: bus.now() });
			speaking = true;
			const onEvent = options.onEvent;
			queueMicrotask(() => {
				if (onEvent) onEvent({ type: "start", charIndex: 0 });
				speaking = false;
				if (onEvent) onEvent({ type: "end", charIndex: utterance.length });
			});
			return bus.settle(callback, undefined);
		},
		stop(): void {
			stops.push(bus.now());
			speaking = false;
		},
		pause(): void {},
		resume(): void {},
		isSpeaking(callback?: (speaking: boolean) => void) {
			return bus.settle(callback, speaking);
		},
		getVoices(callback?: (voices: chrome.tts.TtsVoice[]) => void) {
			return bus.settle(
				callback,
				VOICES.map((v) => ({ ...v }))
			);
		},
	};

	return {
		api,
		/** Every `speak` call in order. */
		calls,
		/** Timestamps of `stop()` calls. */
		stops,
		speaking: (): boolean => speaking,
		clear(): void {
			calls.length = 0;
			stops.length = 0;
		},
	};
}

export type TtsSubsystem = ReturnType<typeof createTtsSubsystem>;
