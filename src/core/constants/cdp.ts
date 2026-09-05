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
	/** The rescale factor applied to a natural travel path is clamped to this band. */
	travelScaleClamp: [0.5, 2.5],
	/** Per-game dominant click style share (drag vs click-click), never a per-move coin flip. */
	dominantStyleShare: 0.7,
	/** Retry attempts including the first (drag → click-click once, no third attempt). */
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
	},
	/** Zero-length `ExecutionResult.timeline` entries that annotate an execution. */
	timelineNotes: {
		promotionGeometryUnavailable: "promotion-geometry-unavailable",
	},
} as const;
