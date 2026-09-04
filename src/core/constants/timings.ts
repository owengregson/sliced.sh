/** Cross-module timing constants (ms unless noted). */
export const TIMINGS = {
	engineReadyTimeoutMs: 20_000,
	engineStopTimeoutMs: 2_000,
	engineRestartBackoffMs: [500, 2_000, 8_000],
	analysisDefaultMovetimeMs: 1_500,
	ponderMaxMs: 60_000,
	panelSnapshotMinIntervalMs: 100,
	engineInfoCoalesceMs: 100,
	adapterDebounceMs: 40,
	adapterSelfCheckIntervalMs: 15_000,
	executorVerifyTimeoutMs: 1_200,
	executorRetryDelayMs: [250, 600],
	debuggerIdleDetachMs: 180_000,
	licenseValidateTimeoutMs: 8_000,
	autoQueueDelayRangeMs: [900, 2_600],
	keybindDebounceMs: 150,
	/** `connectPort` reconnect backoff: base, doubling up to the cap (Task 4). */
	portReconnectBaseMs: 250,
	portReconnectMaxMs: 4_000,
} as const;
