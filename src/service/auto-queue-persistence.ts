/** Pending autoqueues survive an idle MV3 worker through session storage and one wake alarm. */

import { alarmClear, alarmCreate, alarmGet } from "@core/chrome/alarms";
import { chromeSessionGet, chromeSessionSet } from "@core/chrome/storage";
import { ALARM_NAMES } from "@core/constants/alarms";
import { SESSION_KEYS } from "@core/constants/storage-keys";
import type { PendingAutoQueues } from "@typedefs/storage";

export type { PendingAutoQueue, PendingAutoQueues } from "@typedefs/storage";

export interface AutoQueuePersistence {
	/** Validates saved records and repairs their wake alarm before returning. */
	load(): Promise<PendingAutoQueues>;
	/** Captures the current records immediately; serializes persistence and alarm reconciliation. */
	save(records: PendingAutoQueues): Promise<void>;
}

export interface AutoQueuePersistenceDeps {
	read(): Promise<unknown>;
	write(records: PendingAutoQueues): Promise<void>;
	getAlarm(): Promise<chrome.alarms.Alarm | null>;
	setAlarm(when: number): Promise<void>;
	clearAlarm(): Promise<unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only canonical tab ids and finite deadlines are accepted; returned records are detached. */
function validated(value: unknown): PendingAutoQueues {
	const valid: PendingAutoQueues = {};
	if (!record(value)) return valid;
	for (const [tab, pending] of Object.entries(value)) {
		const tabId = Number(tab);
		if (!Number.isSafeInteger(tabId) || tabId < 0 || String(tabId) !== tab || !record(pending))
			continue;
		const { gameId, dueAt } = pending;
		if (gameId !== null && typeof gameId !== "string") continue;
		if (
			typeof dueAt !== "number" ||
			!Number.isFinite(dueAt) ||
			dueAt < 0 ||
			dueAt > Number.MAX_SAFE_INTEGER
		)
			continue;
		valid[tab] = { gameId, dueAt };
	}
	return valid;
}

/**
 * Construct once per worker. The owner synchronously registers ALARM_NAMES.autoQueue with the
 * service lifecycle, then awaits load() inside its startup/alarm work. This helper owns no
 * listener or timer: disposing the in-memory scheduler must not erase a persisted wake alarm.
 */
export function createAutoQueuePersistence(
	options: Partial<AutoQueuePersistenceDeps> = {}
): AutoQueuePersistence {
	const deps: AutoQueuePersistenceDeps = {
		read: () => chromeSessionGet(SESSION_KEYS.autoQueuePending),
		write: (records) => chromeSessionSet(SESSION_KEYS.autoQueuePending, records),
		getAlarm: () => alarmGet(ALARM_NAMES.autoQueue),
		setAlarm: (when) => alarmCreate(ALARM_NAMES.autoQueue, { when }),
		clearAlarm: () => alarmClear(ALARM_NAMES.autoQueue),
		...options,
	};
	let chain: Promise<void> = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = chain.then(operation);
		// Return failures to the owner while allowing the next snapshot/retry to repair the state.
		chain = result.then(
			() => {},
			() => {}
		);
		return result;
	};
	const reconcileAlarm = async (records: PendingAutoQueues): Promise<void> => {
		const deadlines = Object.values(records).map((pending) => pending.dueAt);
		if (!deadlines.length) {
			await deps.clearAlarm();
			return;
		}
		const earliest = Math.min(...deadlines);
		const current = await deps.getAlarm();
		if (current?.scheduledTime === earliest && current.periodInMinutes === undefined) return;
		await deps.setAlarm(earliest);
	};
	return {
		load: () =>
			enqueue(async () => {
				const records = validated(await deps.read());
				await reconcileAlarm(records);
				return records;
			}),
		save: (records) => {
			const snapshot = validated(records);
			return enqueue(async () => {
				await deps.write(snapshot);
				await reconcileAlarm(snapshot);
			});
		},
	};
}
