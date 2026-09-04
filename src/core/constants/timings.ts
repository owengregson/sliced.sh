/** Cross-module timing constants (ms unless noted). */
export const TIMINGS = {
	engineReadyTimeoutMs: 20_000,
	engineStopTimeoutMs: 2_000,
	engineRestartBackoffMs: [500, 2_000, 8_000],
	analysisDefaultMovetimeMs: 1_500,
	ponderMaxMs: 60_000,
	panelSnapshotMinIntervalMs: 100,
	engineInfoCoalesceMs: 100,
	/** Offscreen host → SW: coalesced `info` lines are forwarded at most this often (§6.4). */
	engineInfoForwardMs: 50,
	adapterDebounceMs: 40,
	adapterSelfCheckIntervalMs: 15_000,
	/** `observeMove`: wait for the move list after the piece has landed (Task 20). */
	adapterMoveConfirmMs: 1_500,
	/** Budget for one MAIN-world bridge round trip from an adapter (Task 20). */
	adapterBridgeTimeoutMs: 1_000,
	executorVerifyTimeoutMs: 1_200,
	executorRetryDelayMs: [250, 600],
	debuggerIdleDetachMs: 180_000,
	licenseValidateTimeoutMs: 8_000,
	/** Lichess opening-explorer request timeout (§7.3 item 1, Task 15). */
	explorerTimeoutMs: 1_200,
	autoQueueDelayRangeMs: [900, 2_600],
	keybindDebounceMs: 150,
	/** `connectPort` reconnect backoff: base, doubling up to the cap (Task 4). */
	portReconnectBaseMs: 250,
	portReconnectMaxMs: 4_000,
} as const;
