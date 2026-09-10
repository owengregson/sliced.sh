/**
 * Executor / CDP registry (Task 18): every number and user-facing string of
 * the virtual hand's service-worker half lives here exactly once (C1) —
 * protocol version, dispatch scheduling, debugger attach errors, content-link
 * request budgets and the executor's scheduling policy. Cross-module timings
 * (`executorVerifyTimeoutMs`, `executorRetryDelayMs`, `debuggerIdleDetachMs`)
 * stay in `TIMINGS`.
 */

/** `Input.dispatchMouseEvent` semantics (Appendix G §1) and the absolute-time dispatcher (§7.4). */
export const CDP = {
	/** `chrome.debugger.attach` protocol version (major must match, minor ≥). */
	protocolVersion: "1.3",
	inputDispatchMouseEvent: "Input.dispatchMouseEvent",
	/** A dispatch that lands later than this past its due time resyncs the schedule (GC, throttling). */
	stallResyncMs: 40,
	/** Waits shorter than this are not worth a timer: dispatch immediately. */
	minSleepMs: 1,
	/** `buttons` bitmask / `clickCount` / `modifiers` values the hand ever sends. */
	mouse: { noButtons: 0, leftButtons: 1, clickCount: 1, modifiers: 0 },
} as const;

/** Chrome's attach error text → the panel's user-facing reason (Appendix G §5). */
export const DEBUGGER_ATTACH_REASONS = {
	anotherDebugger: "Another debugger is attached",
	restrictedPage: "Restricted page",
	noTab: "Tab is gone",
	unknown: "Debugger attach failed",
} as const;

/** Substrings of Chrome's `lastError` messages, matched case-insensitively in order. */
export const DEBUGGER_ATTACH_PATTERNS: ReadonlyArray<
	readonly [keyof typeof DEBUGGER_ATTACH_REASONS, string]
> = [
	["anotherDebugger", "another debugger"],
	["anotherDebugger", "already attached"],
	["noTab", "no tab with"],
	["restrictedPage", "cannot attach"],
	["restrictedPage", "cannot access"],
	["restrictedPage", "chrome://"],
	["restrictedPage", "chrome-extension://"],
	["restrictedPage", "policy"],
	["restrictedPage", "web store"],
];

/** `Keepalive.hold` reason while any tab is attached. */
export const DEBUGGER_KEEPALIVE_REASON = "debugger";

/** `ContentLink.request` rejection messages. */
export const CONTENT_LINK_ERRORS = {
	timeout: "timeout",
	noPort: "no content port",
	disconnected: "disconnected",
	disposed: "disposed",
} as const;

/** Reasons the panel handlers (Task 28) reject a command with — the `MessageEnvelope.error` text. */
export const PANEL_COMMAND_ERRORS = {
	/** The tab has no move executor (no game session / content script on it). */
	noExecutor: "no auto-play executor on this tab",
	/** `playNow` needs the hand armed (the debugger attaches at arm time, never mid-game, §13.4). */
	notArmed: "auto-play is not armed",
	noRecommendation: "no move to play yet",
	/** §4.4: `Settings.enabled` is off, so nothing may arm, attach or play (the panel reverts). */
	assistantOff: "the assistant is off",
} as const;

/** Detach reasons Chrome reports on `onDetach` plus the manager's own. */
export const DEBUGGER_DETACH_REASONS = {
	canceledByUser: "canceled_by_user",
	targetClosed: "target_closed",
	idle: "idle",
	requested: "requested",
} as const;

/** Content-link request budgets and executor scheduling policy (§9.3–§9.5, §13.4). */
export const EXECUTOR = {
	/** Reply budget for a `geometry` request (the adapter answers from cached rects). */
	geometryTimeoutMs: 400,
	/** A geometry read older than this is re-read before the approach (§9.5). */
	geometryFreshMs: 250,
	/**
	 * A board rect that differs from the planned one by more than this is a reflow, not rounding
	 * (§9.5): the page moved the board under the hand. Below it the difference cannot put the
	 * release on a different square — a square is an eighth of the board.
	 */
	boardMoveTolerancePx: 4,
	/**
	 * §13.4: attaching the debugger makes Chrome show its infobar, which reflows the page and moves
	 * the board. Before the first execution after an attach the board rect must have been unchanged
	 * for this long — the stability check — so the hand plans on geometry that has stopped moving.
	 */
	attachSettleStableMs: 150,
	/** Whole settle wait after an attach, bounded: a page that never stops moving must not wedge the hand. */
	attachSettleMaxMs: 900,
	/** Poll step of the settle wait. */
	attachSettlePollMs: 25,
	/** How long the content adapter waits for the promotion picker before reporting `null`. */
	promotionPickerTimeoutMs: 1500,
	/** Board re-check before a retry (never double-move): short, both boards update optimistically. */
	recheckTimeoutMs: 150,
	/** A real pointer position reported by the content script is a valid hand start below this age. */
	realCursorMaxAgeMs: 5000,
	/** Smallest whole execution the controller will run (touch only, `playNow` / late plans). */
	minExecutionMs: 250,
	/** Nominal approach budget when the timing plan carries no `window.approachMs`. */
	defaultApproachMs: 300,
	/** Travel is rescaled to the plan's `dragDurationMs` but never below this. */
	minTravelMs: 120,
	/**
	 * Slack allowed when the approach is fitted to `window.approachMs` before the log fires
	 * (Task 30's overrun fix): a path is a whole number of sampled points, so the fitted
	 * duration lands within one sample of the budget.
	 */
	approachFitToleranceMs: 10,
	/** The rescale factor applied to a natural travel path is clamped to this band. */
	travelScaleClamp: [0.5, 2.5],
	/**
	 * The one way a move is committed (`ExecutionResult.tier`): a drag. Click-to-move was removed
	 * end to end after the owner's live game; preview selections (§9.3a) still click, but a
	 * preview is not a move.
	 */
	committedTier: "drag",
	/** Dispatch attempts including the first (a drag, then one more drag; no third attempt). */
	maxAttempts: 2,
	/** Free-move dispatch cadence for the post-drop rest tremor (ms). */
	postDropRestMs: [120, 320] as [number, number],
	/** Executor event names (`MoveExecutor.on`). */
	events: {
		executed: "executed",
		failed: "failed",
		aborted: "aborted",
		skipped: "skipped",
		hand: "hand",
	},
	/** `ExecutionResult.reason` strings the executor reports. */
	reasons: {
		unfocused: "unfocused",
		hidden: "hidden",
		blurInWindow: "blur-in-window",
		notAttached: "debugger not attached",
		unverified: "unverified",
		aborted: "aborted",
		noGeometry: "no board geometry",
		dispatchFailed: "dispatch failed",
		/** The board could not be (re-)checked: never dispatch again on a guess. */
		verificationUnavailable: "verification-unavailable",
		/** The from-square no longer holds our piece / the move is already on the board. */
		positionChanged: "position-changed",
		/** A parked replacement was dropped by `cancel()` / `disarm()` / `dispose()`. */
		dropped: "dropped",
		/**
		 * The board moved (or resized) while the piece was held, so every remaining path point was
		 * in the old coordinate space: the hand put the piece back on its origin square and
		 * submitted nothing rather than dropping it wherever the stale path ended (§9.5).
		 */
		boardMoved: "board-moved",
	},
	/** Zero-length `ExecutionResult.timeline` entries that annotate an execution. */
	timelineNotes: {
		promotionGeometryUnavailable: "promotion-geometry-unavailable",
		/** The board moved while the piece was held; the hand put it back on its origin square. */
		boardMoved: "board-moved",
	},
} as const;
