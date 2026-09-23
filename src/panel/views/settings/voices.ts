/** The TTS voice options: the system default first, then every named voice (with its language). */

import { SETTINGS_COPY } from "../../copy";
import type { SelectOption } from "./controls";

export const DEFAULT_VOICE_OPTIONS: readonly SelectOption[] = [
	{ value: "", label: SETTINGS_COPY.voice.default },
];

export function voiceOptions(voices: readonly chrome.tts.TtsVoice[]): readonly SelectOption[] {
	return [
		{ value: "", label: SETTINGS_COPY.voice.default },
		...voices
			.filter((v): v is chrome.tts.TtsVoice & { voiceName: string } => !!v.voiceName)
			.map((v) => ({
				value: v.voiceName,
				label: v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName,
			})),
	];
}
