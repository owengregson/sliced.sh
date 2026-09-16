/** Cross-module timing constants (ms unless noted). */
export const TIMINGS = {
	engineReadyTimeoutMs: 20_000,
	engineStopTimeoutMs: 2_000,
	engineRestartBackoffMs: [500, 2_000, 8_000],
	analysisDefaultMovetimeMs: 1_500,
	ponderMaxMs: 60_000,
	panelSnapshotMinIntervalMs: 100,
	/**
	 * The panel store re-requests the snapshot this often while its document is visible, and on
	 * every visibility/focus return (owner, 2026-09-13: the Live view sometimes did not learn a
	 * game had started until the side panel was closed and reopened — the reopen's own request is
	 * exactly what a poll repeats). Keeps the worker awake while the panel is open, by design.
	 */
	panelSnapshotPollMs: 2_500,
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
	autoQueueMinuteMs: 60_000,
	autoQueueRequestTimeoutMs: 2_000,
	autoQueueRetryMs: 2_000,
	autoQueueRetryMaxMs: 15_000,
	autoQueueSearchPollMs: 5_000,
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
	/**
	 * How long a `GameSession` holds the game's first position when the site has not reported the
	 * time control yet. The control arrives on a republish of that unmoved position (§4.3), and a
	 * move decided before it is decided *again* when it lands — on a different budget, so usually
	 * on a different move, with the mark on the board jumping under the owner's eyes. Bounded: a
	 * page that never answers (`/play/computer`) costs the first move this much and nothing more.
	 */
	timeControlGraceMs: 1_500,
	/**
	 * chess.com renders the player card — and the rating inside it — after the board, so the
	 * content script's first opponent read answers nothing or a rating-less name. Re-read at this
	 * cadence until a rating is found, at most this many times.
	 */
	opponentReadRetryMs: 1_000,
	opponentReadRetryMax: 30,
	/**
	 * Fix D: how long the pointer mirror takes to fade in once the hand's first point arrives
	 * (the reference implementation's `transition: opacity 0.4s ease`). Only a fade *in* exists —
	 * the element is removed on hide, per the §13.3 presence rules.
	 */
	virtualCursorFadeMs: 400,
	/**
	 * How long a `GameSession` waits before re-delivering a my-turn position it could not act on
	 * yet, and how many times it tries (`GameSession.reconsider`). Playing white at ply 0 the
	 * position cannot change until the owner moves by hand, so nothing else will ever re-deliver it
	 * and a momentary "not ready" — the hand still attaching the debugger, the engine still
	 * answering nothing — would otherwise be permanent.
	 *
	 * Short, because the whole budget has to fit inside the first move's think time; bounded,
	 * because a genuinely dead engine must give up and say so rather than poll for the rest of the
	 * game. 250 ms × 12 covers the first three seconds of the move.
	 */
	sessionRetryMs: 250,
	/**
	 * 10 s of asking again: long enough for a crashed engine's backoff (`engineRestartBackoffMs`
	 * 0.5 s + 2 s), a reboot and its nets — including the small-net fallback after a full-build
	 * crash — to come back before the position is written off (owner's 2026-09-12 report: the
	 * old 3 s gave up while the engine was still rebooting).
	 */
	sessionRetryMax: 40,
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
	 * 1.8 s, every hard cap at 0.9 s, every move in the emergency regime. The clock the page is
	 * showing is the second witness, but **only when the increment is zero**: with no increment the
	 * clock can never exceed the base, so a clock larger than it proves the units differ and the
	 * comparison has no false positive. With an increment it proves nothing — a 1+60 game's clock
	 * passes ten times its base after nine moves, and reading *that* as seconds turns a one-minute
	 * game into 16.7 hours.
	 *
	 * The factor is 100, not 2, for a second false positive: the clocks on the page can briefly
	 * belong to the *previous* game (a rematch re-renders them), so a 1+0 game can legitimately be
	 * read beside a finished 10- or 30-minute game's clock — a ratio of 10 to 30. The seconds
	 * hypothesis predicts `clock ≈ base × 1000`, so demanding 100× separates them with room to
	 * spare and still catches a seconds-reported game through the first 90 % of its clock.
	 */
	clockExceedsBaseFactor: 100,
	msPerSecond: 1_000,
	/** Beyond 24 h the value is not a clock in ms either (nor in seconds). */
	maxPlausibleMs: 86_400_000,
	/**
	 * The largest base a *live* game can have, and the discriminator the clock witness needs. A
	 * stale clock from the previous game is not evidence about this one, and bounding the hint by
	 * `maxPlausibleMs` (a day) is far too loose to notice: `{60_000, 0}` beside a leftover two-hour
	 * clock still satisfied "the clock exceeds the base a hundredfold" and read a one-minute game as
	 * 16.7 h. The discriminating question is whether the *seconds hypothesis* yields a base a live
	 * game could actually have. chess.com's custom live maximum is 180 minutes, so anything the
	 * rescale would push past that is the stale clock talking, not the unit.
	 */
	maxLiveBaseMs: 10_800_000,
	/**
	 * How many times one game re-asks for a time control it has not been told. At
	 * `TIMINGS.adapterTimeControlRetryMs` this covers the first half-minute after the board
	 * appears, which is the window in which a game that was "not yet started" starts.
	 */
	maxProbes: 30,
} as const;

/**
 * The timing presets (`manual` / `fast` / `natural` / `slow` / `custom`) were removed on
 * 2026-09-15 at the owner's request ("remove the timing presets 'fast natural slow' etc."). The
 * user's own timing sliders always apply now, re-based only by `SETTING_GAIN` for the detected
 * time-control class — see `timingSettingsFor` (`src/service/game-session/presets.ts`).
 */

/** One-shot recommendation feedback; all durations are independent of the move's think time. */
export const HIGHLIGHT_MOTION = {
	squareInMs: 200,
	arrowDrawMs: 340,
	arrowHoldMs: 180,
	arrowFadeMs: 300,
	/**
	 * A cleared mark fades out over this rather than vanishing (owner, 2026-09-12: in a fast
	 * endgame the marks were snapping out one after another). The fading overlay is detached
	 * from lookup, so the next draw gets a fresh one on top of it.
	 */
	clearFadeMs: 220,
	drawEasing: "cubic-bezier(0.22, 0.68, 0.3, 1)",
	reducedMotionQuery: "(prefers-reduced-motion: reduce)",
} as const;
