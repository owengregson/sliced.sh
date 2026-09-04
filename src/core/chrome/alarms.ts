/** Promise wrappers over `chrome.alarms.*`; names come from `ALARM_NAMES`. */

export function alarmCreate(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.alarms.create(name, info, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}

export function alarmGet(name: string): Promise<chrome.alarms.Alarm | null> {
	return new Promise((resolve, reject) =>
		chrome.alarms.get(name, (alarm) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(alarm ?? null);
		})
	);
}

/** Resolves `true` when an alarm with that name was cleared. */
export function alarmClear(name: string): Promise<boolean> {
	return new Promise((resolve, reject) =>
		chrome.alarms.clear(name, (wasCleared) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(wasCleared);
		})
	);
}
