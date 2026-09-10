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
	autoQueueDelayRangeMs: [900, 2_600],
	keybindDebounceMs: 150,
	/** MAIN-world bridge: board retry, doubling up to the cap (Task 21). */
	bridgeRetryMs: 250,
	bridgeRetryMaxMs: 2_000,
	/** Content cursor tracker: minimum spacing of `pointermove` samples posted on the game port (Task 21). */
	cursorReportIntervalMs: 200,
	/** Content entry: readiness poll while a live page has no readable board yet (Task 21). */
	contentReadyPollMs: 500,
	/** `connectPort` reconnect backoff: base, doubling up to the cap (Task 4). */
	portReconnectBaseMs: 250,
	portReconnectMaxMs: 4_000,
	/**
	 * Task 12/34: a relayed asset download (`AssetStore`) that goes this long without a chunk is
	 * abandoned. It is a *stall* budget, rearmed by every chunk, not a total: a 72 MB NNUE on a
	 * slow link must still finish. Without it a service worker that never answers a
	 * `nnue-request` / `model-request` leaves the pending promise forever, which wedges the
	 * asset (and, for a band, the timing head's substitute path).
	 */
	assetDownloadStallMs: 120_000,
	/**
	 * Backstop on a whole relayed download, armed once when the request goes out. The stall
	 * budget is the real bound; this only catches a pathological trickle (our own service worker
	 * dripping one small chunk just inside every stall window). Sized so the largest asset —
	 * a ~72 MB NNUE — still completes on a ~160 kbit/s link.
	 */
	assetDownloadTotalMs: 3_600_000,
	/**
	 * Task 34: a ChessMimic band whose session failed to load is tried again after this, doubling
	 * per consecutive failure up to `timingBandRetryMaxMs`. A band is never disabled permanently
	 * (a failure can be a dropped port or a stalled relay), but a genuinely broken one must not
	 * re-read 18 MB every 30 s for the life of the document.
	 */
	timingBandRetryMs: 30_000,
	timingBandRetryMaxMs: 900_000,
	/**
	 * §4.3: how often the adapter re-asks the site for its time control while the page shows
	 * clocks and the site has not answered yet (`timeControl.get()` is null until the game
	 * actually starts). Slow on purpose — one passive bridge round trip per tick, bounded by
	 * `TIME_CONTROL.maxProbes`.
	 */
	adapterTimeControlRetryMs: 1_000,
} as const;

/**
 * Reading the site's own time control (§4.3, Appendix C §1.4).
 *
 * chess.com's `board.game.timeControl.get()` answers `{baseTime, increment}`. The owner's live
 * capture on a **3 minute** game was `{"baseTime":180000,"increment":0}`, so `baseTime` is in
 * MILLISECONDS. The increment was 0 in that sample, so its unit is UNCONFIRMED: it is read as
 * ms to match, with the implausible case guarded — chess.com's increments are whole seconds, so
 * a nonzero increment below one second cannot be a millisecond reading, and planning with a 2 ms
 * increment would be silently wrong in every downstream term (`base_eff`, the class, the premove
 * gate). A value below the threshold is therefore read as seconds and logged loudly.
 */
export const TIME_CONTROL = {
	/** A nonzero base/increment below this many ms is not a millisecond reading. */
	minPlausibleMs: 1_000,
	/**
	 * The magnitude test alone only catches a *small* seconds value: a 30-minute game reported in
	 * seconds is `1800`, which passes `minPlausibleMs` and then reads as a 1.8 s base — `base_eff`
	 * 1.8 s, every hard cap at 0.9 s, every move in the emergency regime. So the base is also
	 * cross-checked against the clock the page is *showing*: a clock this many times larger than the
	 * claimed base cannot be the same unit (a clock can exceed its base slightly on increments,
	 * never tenfold), so the pair is read as seconds and logged.
	 */
	unitMismatchFactor: 10,
	msPerSecond: 1_000,
	/** Beyond 24 h the value is not a clock in ms either (nor in seconds). */
	maxPlausibleMs: 86_400_000,
	/**
	 * How many times one game re-asks for a time control it has not been told. At
	 * `TIMINGS.adapterTimeControlRetryMs` this covers the first half-minute after the board
	 * appears, which is the window in which a game that was "not yet started" starts.
	 */
	maxProbes: 30,
} as const;

/** Time-control classes a timing preset is keyed by (the timing model's `TcClass` minus untimed). */
export type TimedTcClass = "bullet" | "blitz" | "rapid" | "classical";

/**
 * The timing preset a detected time control selects (Appendix F §4.6). The Settings view's
 * preset chips display it and the `GameSession` applies it (Task 30): the session's effective
 * `timing.profile` is this entry whenever the stored profile is itself a *detected* preset
 * (`fast` / `natural` / `slow`), so what the chips show is what the timing model runs.
 */
export const PROFILE_FOR_TC_CLASS: Readonly<Record<TimedTcClass, TimingProfile>> = {
	bullet: "fast",
	blitz: "natural",
	rapid: "natural",
	classical: "slow",
};

/** `Settings["timing"]["profile"]` without importing the whole settings surface into a registry. */
export type TimingProfile = "manual" | "fast" | "natural" | "slow" | "custom";

/**
 * What a preset means numerically. `natural` is the identity, `fast` is one 4/3 step quicker and
 * `slow` its reciprocal rounded to the speed slider's 0.05 step (`SETTINGS_RANGES.speedScale`),
 * so the two presets are log-symmetric about `natural`. `manual` and `custom` carry no knobs:
 * `custom` runs the user's stored sliders and `manual` additionally never auto-plays
 * (`COPY.timing.manualOnly`, "Never auto-plays; shows recommendations only.").
 */
export const TIMING_PROFILE_KNOBS: Readonly<
	Record<TimedTcClassPreset, { readonly speedScale: number }>
> = {
	fast: { speedScale: 0.75 },
	natural: { speedScale: 1 },
	slow: { speedScale: 1.35 },
};

/** The presets a detected time control can select (the rest are the user's own choice). */
export type TimedTcClassPreset = "fast" | "natural" | "slow";

/** `manual` shows recommendations and never auto-plays (§4.6). */
export const MANUAL_TIMING_PROFILE = "manual" satisfies TimingProfile;
