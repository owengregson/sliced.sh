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
