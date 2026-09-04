/** `speak(text)` over `chrome.tts`, honouring `Settings.display.ttsVoice`; `stop()` cancels. */

import { ttsSpeak, ttsStop } from "@core/chrome/tts";
import { getSettings } from "@core/storage/settings-storage";

export async function speak(text: string): Promise<void> {
	const settings = await getSettings();
	const options: chrome.tts.TtsOptions = { enqueue: false };
	if (settings.display.ttsVoice) options.voiceName = settings.display.ttsVoice;
	await ttsSpeak(text, options);
}

export function stop(): Promise<void> {
	return ttsStop();
}
