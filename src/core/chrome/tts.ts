/** Promise wrappers over `chrome.tts.*`. `ttsSpeak` resolves once speech has been queued. */

export function ttsSpeak(text: string, options: chrome.tts.TtsOptions = {}): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.tts.speak(text, options, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}

export function ttsStop(): Promise<void> {
	chrome.tts.stop();
	return Promise.resolve();
}

/** Installed voices (`chrome.tts.getVoices`), `lastError`-checked; empty when the API has none. */
export function ttsGetVoices(): Promise<chrome.tts.TtsVoice[]> {
	return new Promise((resolve, reject) =>
		chrome.tts.getVoices((voices) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(voices ?? []);
		})
	);
}
