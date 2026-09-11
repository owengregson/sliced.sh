/**
 * Every user-visible string of the panel, transcribed once from Appendix F §7 (tone: crisp,
 * sentence case, no emojis, no exclamation marks). Parameterised strings are functions so the
 * numbers stay specific ("4.2s", "d18"). Views and components import from here; no string
 * literal shown to the user may live anywhere else under `src/panel/`.
 */

import { LIMITS } from "@core/constants/limits";
import type { PersonaId } from "@typedefs/settings";

/** The one supported site, as the panel names it — defined once, like every other string here. */
const SITE = "chess.com";

export const COPY = {
	brand: {
		name: "sliced",
		product: "sliced.gg",
		tagline: `Chess assistant for ${SITE}`,
	},
	nav: { game: "Game", settings: "Settings", engine: "Engine", viewSwitch: "Panel navigation" },
	workspace: {
		connecting: "Connecting…",
		connectingBody: "Loading session and settings.",
		live: "Live",
		yourTurn: "Your move",
		theirTurn: "Waiting…",
		setup: "Session setup",
		settingsTitle: "Settings",
		settingsBody: "Changes save automatically.",
		engineTitle: "Engine diagnostics",
		engineBody: "Engine, input and timing status.",
		shortcuts: "Page shortcuts",
		playNow: "Play now",
		autoPlay: "Auto-play",
		stop: "Stop",
		searchSettings: "Search settings",
		searchPlaceholder: "Search settings…",
		noSettings: "No matching settings.",
		saving: "Saving…",
		saved: "Saved",
		saveFailed: "Save failed. Previous values restored.",
	},
	login: {
		title: "sliced",
		subtitle: `Chess assistant for ${SITE}`,
		fieldLabel: "License key",
		hint: "Keys look like SL-XXXX-XXXX-XXXX.",
		button: "Continue",
		loading: "Checking key…",
		invalid: "Invalid license key. Verify the key in Account.",
		deviceLimit: (n: number): string => `Device limit reached (${n}). Remove a device in Account.`,
		offline: "Connection failed. Check network access and retry.",
		expired: (date: string): string => `This key expired on ${date}.`,
		link: "Get a license key",
		reveal: "Show key",
		hide: "Hide key",
	},
	unsupported: {
		title: "Unsupported page",
		body: `Open a ${SITE} game in this tab.`,
		note: "Auto-play stays off until a game starts.",
	},
	nonGame: {
		title: "No game detected",
		body: "Start or join a game.",
	},
	waiting: {
		title: "Waiting…",
		meta: (engine: string): string => `${SITE} · ${engine}`,
		engineReady: "engine ready",
		engineLoading: "engine loading",
		watching: "Connected",
		reading: "Reading position…",
		autoplayTooltip: "Turns on when a game starts",
		preArmed: "Armed for next game",
		/** §4.4: the master switch is off, so there is nothing to arm (`COPY.move.disabled` names it). */
		autoplayOff: "Assistant disabled in Settings",
	},
	move: {
		nextMove: "Next move",
		expectedReply: "Expected reply",
		placeholder: "—",
		remaining: (seconds: string): string => `${seconds}s`,
		remainingLabel: (seconds: string): string => `${seconds} seconds until execution`,
		progress: {
			waiting: { title: "Waiting…", label: "Next action", value: "Opponent move" },
			analysing: { title: "Analysing…", label: "Position search", value: "In progress" },
			thinking: { title: "Waiting…", label: "Execution in", value: "Scheduled" },
			ready: { title: "Ready", label: "Execution", value: "Awaiting command" },
			executing: { title: "Executing…", label: "Board input", value: "In progress" },
			paused: { title: "Paused", label: "Assistant", value: "Disabled" },
			error: { title: "Engine error", label: "Analysis", value: "Unavailable" },
			reading: { title: "Reading…", label: "Board position", value: "Pending" },
		},
		headerYours: (color: string): string => `Your move · ${color}`,
		headerTheirs: "Opponent to move",
		thinking: "Thinking…",
		engineStopped: "Engine stopped",
		engineStoppedHint: (stop: string): string =>
			`${stop}: release pointer. Restart engine after the game.`,
		noteBook: "Book move",
		noteSearch: (depth: number): string => `Search depth ${depth}`,
		notePrediction: "Main line prediction",
		noteOnly: "Only move",
		noteMate: (n: number): string => `Mate in ${n}`,
		noteForced: "Forced",
		/** Your move, a recommendation shown, but the hand is not armed: say how to arm it. */
		noteUnarmed: (key: string): string => `Arm before the game; ${key} toggles auto-play.`,
		// There is no "D" shortcut: the only control is the Settings view's Assistant toggle.
		disabled: "Assistant disabled",
		plan: (seconds: string, method: string, premove: boolean): string =>
			`Delay ${seconds}s · ${method}${premove ? " · premove" : ""}`,
		play: "Play move",
		playShort: "Play",
		armed: (seconds: string): string => `Auto-playing in ${seconds}s`,
		cancel: "Cancel this move",
		executing: "Executing…",
		ariaRecommended: (spoken: string, uci: string): string => `Recommended: ${spoken}, ${uci}`,
		ariaArmed: (spoken: string, seconds: number): string =>
			`Auto-playing ${spoken} in ${seconds} ${seconds === 1 ? "second" : "seconds"}. Activate to cancel.`,
		white: "white",
		black: "black",
	},
	lines: { header: "Lines", empty: "No lines", depth: (d: number): string => `d${d}` },
	strength: {
		card: (elo: number, band: string, persona: string): string => `${elo} ${band} · ${persona}`,
		popoverFooter: "Applies from next move",
		bands: { casual: "Casual", club: "Club", expert: "Expert", master: "Master", elite: "Elite" },
		warning: "High-strength range",
		smallNetwork: "Small NNUE",
		largeNetwork: "Large NNUE",
		networkCutoff: (elo: number): string => String(elo),
		networkDescription: (cutoff: number, max: number): string =>
			`Above ${cutoff}: automatic large NNUE download. ${max}: maximum engine strength; approximate rating.`,
	},
	persona: {
		cautious: "Solid moves; longer think times.",
		balanced: "Balanced move selection and timing.",
		aggressive: "Tactical lines; faster replies.",
		blitz: "Fast timing; higher move variance.",
	} satisfies Record<PersonaId, string>,
	personaName: {
		cautious: "Cautious",
		balanced: "Balanced",
		aggressive: "Aggressive",
		blitz: "Blitz-demon",
	} satisfies Record<PersonaId, string>,
	toggle: {
		autoplay: "Auto-play",
		highlight: "Highlight",
		autoqueue: "Auto-queue",
		arming: "Hold to turn on",
		armed: "Auto-play on",
		off: "Auto-play off",
		armTooltip: "Hold to arm auto-play",
		locked: "Locked",
	},
	session: (games: number, pct: number, avg: string): string =>
		`${games} games · ${pct}% vs target · ${avg}s avg move`,
	telemetry: { clean: "clean", blur: "blur seen", mouse: "mouse touched", label: "Telemetry" },
	executor: { attached: "Attached", detached: "Detached", notStarted: "Not started" },
	engine: {
		idle: "Ready",
		thinking: (depth: number): string => (depth > 0 ? `Thinking · d${depth}` : "Thinking…"),
		locked: "Locked",
		stopped: "Stopped",
		loading: "Loading…",
		rows: {
			version: (v: string, nnue: string): string => `Stockfish ${v} · ${nnue}`,
			nnueLoaded: "NNUE loaded",
			resources: (threads: number, hashMb: number): string => `Threads ${threads} · Hash ${hashMb} MB`,
		},
		logKinds: { plan: "plan", exec: "exec", verify: "verify", warn: "warn" },
	},
	toast: {
		played: (san: string, seconds: string, method: string): string =>
			`Played ${san} · ${seconds}s · ${method}`,
		skipped: (san: string): string => `Skipped ${san} · auto-play stays on`,
		disarmed: (san: string): string => `Auto-play off · ${san} not played`,
		verifyFailed: (san: string): string => `Position mismatch after ${san}. Auto-play disabled.`,
		playFailed: "Move failed. Auto-play disabled.",
		keybind: (action: string, key: string): string => `${action} is now ${key}`,
		preArm: (key: string): string => `Turning on auto-play… press ${key} again to cancel`,
		reattached: "Auto-play back on",
		settingsSaved: "Settings saved",
		notVerified: "Move not verified — board differs from expected",
	},
	banner: {
		detached: "Auto-play paused. Chrome's debugging session was closed.",
		reattach: "Reattach",
		dismiss: "Dismiss",
		failures: "Auto-play turned off after two failed moves. Check Engine for details.",
		openEngine: "Open Engine",
		engineStopped: "The engine stopped.",
		restartEngine: "Restart engine",
		update: (version: string): string => `sliced ${version} is ready`,
		updateAction: "Update",
		debugger: "Debugger attached. Cancel pauses auto-play.",
		gotIt: "Dismiss",
		handsOff: "Read-only during live play. Control auto-play with shortcuts.",
		focus: "Page focus unavailable. Auto-play paused.",
	},
	update: {
		title: (version: string): string => `sliced ${version} is ready`,
		primary: "Restart and update",
		later: "Later",
		note: "Restart pauses assistance; the game continues. Update between games.",
	},
	expired: {
		title: "License expired",
		body: (date: string): string =>
			`Assistance disabled since ${date}. Renewal required. Settings retained.`,
		renew: "Renew at sliced.gg",
		differentKey: "Enter a different key",
		revokedTitle: "License invalid",
		revokedBody: "Key revoked or replaced. Verify the key in Account.",
		ipLimitTitle: "Device limit reached",
	},
	keybind: {
		capturing: "Press a key…",
		notSet: "Not set",
		conflict: (action: string): string =>
			`Already used for ${action} — press another key, or Enter to swap`,
		global: "Global shortcuts need Ctrl or Alt.",
		clear: "Clear",
		actions: {
			playMove: "Play move",
			toggleAutoMove: "Toggle auto-play",
			disable: "Disable assistant",
			speakMove: "Speak move",
		},
		keys: {
			space: "Space",
			enter: "Enter",
			escape: "Esc",
			backspace: "Backspace",
			delete: "Del",
			tab: "Tab",
			up: "↑",
			down: "↓",
			left: "←",
			right: "→",
			ctrl: "Ctrl",
			alt: "Alt",
			shift: "Shift",
			meta: "Cmd",
			more: "…",
		},
	},
	timing: {
		detected: (label: string): string => `Detected: ${label}`,
		overrides: "Overrides detection for this game",
		manualOnly: "Never auto-plays; shows recommendations only.",
	},
	execution: {
		debugger:
			"Chrome debugger required for input. Cancel detaches the debugger and pauses auto-play.",
		verify: "After each move, checks the board matches the expected position.",
		drag: "drag",
	},
	account: {
		license: "License",
		plan: "Plan",
		device: "This device",
		signOut: "Sign out",
		signOutConfirm: "Sign out on this device? Your settings stay.",
		resetConfirm: "Reset all settings to defaults? Keybinds and strength included.",
		reset: "Reset",
		cancel: "Cancel",
		clearLog: "Clear log",
	},
	clock: { unavailable: "clock unavailable", unknown: "—:—" },
	eval: {
		label: "Eval",
		pending: "—",
		pendingLabel: "Evaluation pending",
		cachedLabel: "Last eval",
		cached: (value: string): string => `Last evaluation · ${value}`,
		wdlWin: (value: number): string => `W ${value}`,
		wdlDraw: (value: number): string => `D ${value}`,
		wdlLoss: (value: number): string => `L ${value}`,
		valueText: (score: string, win: number, draw: number, loss: number): string =>
			`${score}, ${win}% win, ${draw}% draw, ${loss}% loss`,
		mateFor: (n: number, side: string): string => `Mate in ${n} for ${side}`,
		mateShort: (n: number): string => `M${n}`,
		whiteName: "White",
		blackName: "Black",
	},
	ring: { remaining: (seconds: string): string => `in ${seconds}s` },
	footer: (version: string, build: string): string => `sliced v${version} · build ${build}`,
	/** Third-party notices under the footer (Task 34; the full texts are in docs/third-party.md). */
	notices: {
		engine: "Stockfish 18 · GPL-3.0 / AGPL-3.0 · lichess-org/stockfish-web",
		timing: "ChessMimic timing model © 2026 Thomas Johnson · PolyForm Noncommercial 1.0.0",
	},
	common: {
		close: "Close",
		back: "Back",
		loading: "Loading…",
		on: "On",
		off: "Off",
		popoverClose: "Close",
	},
	a11y: {
		pieces: { N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" },
		takes: "takes",
		check: "check",
		checkmate: "checkmate",
		castleKing: "castles kingside",
		castleQueen: "castles queenside",
		promotes: "promotes to",
		toggleHoldHint: "Hold to arm auto-play",
	},
	// ── Task 26: Engine & diagnostics view (Appendix F §4.7, V2 §3.6) ─────────────────────────
	engineView: {
		sections: {
			engine: "Engine",
			executor: "Executor",
			timing: "Timing model",
			session: "Session",
			log: "Log",
		},
		depth: (d: number): string => `depth ${d}`,
		nps: {
			mega: (n: string): string => `${n} Mn/s`,
			kilo: (n: string): string => `${n} kn/s`,
			unit: (n: string): string => `${n} n/s`,
		},
		sparkline: "Nodes per second, last 60 seconds",
		none: "—",
		rows: {
			debugger: "Debugger",
			target: "Target",
			input: "Input mode",
			last: "Last action",
			license: "License",
		},
		site: SITE,
		target: (gameId: string): string => `${SITE} · game ${gameId}`,
		profiles: {
			manual: "Manual",
			fast: "Fast",
			natural: "Natural",
			slow: "Slow",
			custom: "Custom",
		},
		inputMode: (style: string, profile: string): string => `${style} · ${profile}`,
		outcomes: {
			executed: "executed",
			dispatched: "premove sent",
			skipped: "skipped",
			paused: "paused",
			aborted: "aborted",
			failed: "failed",
		},
		lastAction: (tier: string, seconds: string, outcome: string): string =>
			`${tier} · ${seconds}s · ${outcome}`,
		phase: (name: string, ms: number): string => `${name} ${ms}ms`,
		detach: "Detach",
		licenseVerdict: (raw: string, forced: boolean): string =>
			forced ? `${raw} (forced valid)` : raw,
		rationale: {
			base: (seconds: string, mode: string, persona: string): string =>
				`base ${seconds}s (${mode} · ${persona})`,
			term: (name: string, seconds: string): string => `${seconds}s ${name}`,
			factors: (comp: string, eps: string): string => `complexity ${comp} · eps ${eps}`,
			total: (seconds: string, mode: string): string => `= ${seconds}s · ${mode}`,
			exec: (seconds: string, delta: string): string => `actual ${seconds}s (Δ ${delta}s)`,
			verify: (delta: string): string => `within plan (Δ ${delta}s)`,
			warn: (delta: string): string => `drifted from plan (Δ ${delta}s)`,
		},
		copy: "Copy log",
		export: "Export",
		clear: "Clear",
		copied: "Log copied",
		copyFailed: "Copy failed",
		logEmpty: "No timing entries",
		session: (games: number, moves: number, avg: string): string =>
			`${games} games · ${moves} moves · ${avg}s avg move`,
		reset: "Reset session",
		level: "Level",
		levels: { silent: "Silent", error: "Error", warn: "Warn", info: "Info", debug: "Debug" },
		consoleEmpty: "No log entries",
	},
	// ── Task 23: login / expired / unsupported / waiting / update views (Appendix F §4.1–4.3,
	// §4.8–4.10) — strings the §7.2 table leaves implicit ──────────────────────────────────────
	loginView: {
		placeholder: "SL-XXXX-XXXX-XXXX",
		tryAgain: "Try again",
		manageDevices: "Manage devices",
		renew: "Renew",
		expiredNoDate: "This key has expired.",
		version: (version: string): string => `v${version}`,
	},
	expiredView: {
		bodyNoDate: "Assistance disabled. Renewal required. Settings retained.",
		recheck: "Check again",
		signedIn: (maskedKey: string): string => `Signed in with ${maskedKey}`,
	},
	unsupportedView: { chesscom: SITE, play: "Play" },
	waitingView: {
		engineStopped: "engine stopped",
		opponent: "Opponent",
		noOpponent: "No opponent",
		bot: "Bot",
		rating: (rating: number): string => `Rated ${rating}`,
		ratingUnknown: "opponent rating unknown",
		target: (elo: number): string => `Target ${elo}`,
		lastSession: "Last session",
		session: (games: number, moves: number, avg: string): string =>
			`${games} games · ${moves} moves · ${avg}s avg move`,
		newGame: "Start a new game",
	},
	catFacts: {
		title: "Cat facts",
		another: "Another",
		facts: [
			"A group of kittens is called a kindle.",
			"Cats spend about two thirds of their lives asleep.",
			"A cat's nose print is unique, much like a human fingerprint.",
			"Cats can rotate their ears 180 degrees.",
			"The oldest known pet cat lived around 9,500 years ago in Cyprus.",
			"A cat cannot see directly under its own nose.",
			"Cats have a third eyelid called the haw.",
			"Adult cats only meow to communicate with humans, not with other cats.",
		],
	},
} as const;

/** Heading shown by the placeholder view registry until Tasks 23–26 land the real views. */
export function viewTitle(
	name: "login" | "expired" | "unsupported" | "waiting" | "live" | "settings" | "engine" | "update",
	version: string
): string {
	switch (name) {
		case "login":
			return COPY.login.title;
		case "expired":
			return COPY.expired.title;
		case "unsupported":
			return COPY.unsupported.title;
		case "waiting":
			return COPY.waiting.title;
		case "live":
			return COPY.nav.game;
		case "settings":
			return COPY.nav.settings;
		case "engine":
			return COPY.nav.engine;
		case "update":
			return COPY.update.title(version);
	}
}

// ── Task 25: settings view (Appendix F §4.6 / §7.2) ─────────────────────────────────────────
// Row labels and help are keyed by the `Settings` leaf path so `views/settings/rows.ts` can
// look them up by path; strings that already exist in `COPY` are referenced, not repeated.

type SettingsRowCopy = Readonly<{ label: string; help?: string }>;

export const SETTINGS_COPY = {
	sections: {
		strength: "Strength",
		timing: "Timing",
		execution: "Execution",
		keybinds: "Keybinds",
		display: "Display",
		account: "Account",
		advanced: "Advanced",
	},
	jump: "Jump to section",
	rows: {
		enabled: {
			label: "Assistant",
			help: "Off stops analysis and auto-play. Re-arming required after enabling.",
		},
		"strength.targetElo": {
			label: "Target rating",
			help: COPY.strength.networkDescription(LIMITS.nnueSmallEloMax, LIMITS.eloMax),
		},
		"strength.matchOpponentRating": {
			label: "Match opponent rating",
			help: "Uses the opponent rating plus persona offset each game.",
		},
		"strength.personaEloOffset": {
			label: "Persona offset",
			help: "Added to the opponent's rating when matching.",
		},
		"strength.persona": { label: "Persona" },
		"strength.selectionMode": { label: "Move selection" },
		"strength.useOpeningBook": {
			label: "Opening book",
			help: "Plays book moves for the first 8–12 moves.",
		},
		"strength.blunderScale": { label: "Blunder rate" },
		"timing.profile": { label: "Preset" },
		"timing.speedScale": { label: "Base speed" },
		"timing.varianceScale": { label: "Variance" },
		"timing.premoveTendency": { label: "Premove tendency" },
		"timing.longThinkFrequency": { label: "Long-think frequency" },
		"timing.respectBudget": {
			label: "Respect clock budget",
			help: "Plays faster as the clock runs low.",
		},
		"execution.motorSpeed": { label: "Motor speed" },
		"execution.calibrateFromMyMouse": {
			label: "Calibrate from my mouse",
			help: "Calibrates input from mouse movement between games.",
		},
		"execution.keepDebuggerAttached": { label: "Keep debugger attached" },
		"execution.verifyMoves": { label: "Verify moves after playing" },
		"execution.backend": { label: "Input backend" },
		"execution.previewSelects": {
			label: "Preview selections",
			help: "Sometimes selects a piece before moving, at a modelled rate.",
		},
		"execution.previewSelectScale": { label: "Preview rate" },
		"automation.autoMove": {
			label: "Auto-play",
			help: "Armed when a game starts. Hold the toggle in Game to arm one game.",
		},
		"automation.autoQueue": {
			label: "Auto-queue",
			help: "Starts the next game when one ends.",
		},
		"automation.highlightMoves": {
			label: "Highlight moves",
			help: "Marks the recommended move on the board.",
		},
		"automation.highlightStyle": { label: "Highlight style" },
		"keybinds.playMove": { label: COPY.keybind.actions.playMove },
		"keybinds.toggleAutoMove": { label: COPY.keybind.actions.toggleAutoMove },
		"keybinds.disable": { label: COPY.keybind.actions.disable },
		"keybinds.speakMove": { label: COPY.keybind.actions.speakMove },
		"keybinds.global": { label: "Scope" },
		"display.evalBar": { label: "Eval bar" },
		"display.pvCount": { label: "Lines shown" },
		"display.uiSounds": {
			label: "Control sounds",
			help: "Feedback for settings and controls. Moves are always silent.",
		},
		"display.tts": {
			label: "Spoken move shortcut",
			help: "Read the move when you use the speak shortcut. Moves are never announced automatically.",
		},
		"display.ttsVoice": {
			label: "Spoken move voice",
			help: "Voice for the speak move shortcut.",
		},
		"display.theme": { label: "Theme" },
		"display.reducedMotion": { label: "Reduced motion" },
		"display.virtualCursor": {
			label: "Virtual pointer",
			help: "Hides the system pointer and blocks physical mouse input while active.",
		},
		"engine.threads": { label: "Engine threads" },
		"engine.hashMb": { label: "Hash" },
		"engine.depthCap": { label: "Depth cap" },
		"engine.multiPv": { label: "Engine lines" },
		"engine.nnue": {
			label: "Network",
			help: COPY.strength.networkDescription(LIMITS.nnueSmallEloMax, LIMITS.eloMax),
		},
		"advanced.logLevel": { label: "Debug log level" },
		"advanced.timingLogEnabled": {
			label: "Timing log",
			help: "Keeps plan / exec / verify entries for export.",
		},
	} satisfies Record<string, SettingsRowCopy>,
	options: {
		profile: { manual: "Manual", fast: "Fast", natural: "Natural", slow: "Slow", custom: "Custom" },
		selectionMode: {
			"engine-elo": "Engine rating",
			"persona-sampling": "Persona sampling",
			hybrid: "Hybrid",
		},
		backend: { cdp: "Chrome debugger", native: "Native" },
		previewSelects: { auto: "Auto", off: "Off" },
		highlightStyle: { squares: "Squares", arrows: "Arrows", both: "Both" },
		scope: { page: "In page", global: "Global" },
		theme: { dark: "Dark", light: "Light", system: "System" },
		reducedMotion: { system: "System", on: "On", off: "Off" },
		nnue: { small: "Small", big: "Large", auto: "Auto" },
		logLevel: { silent: "Silent", error: "Error", warn: "Warn", info: "Info", debug: "Debug" },
	},
	format: {
		times: (x: number): string => `${x.toFixed(2)}×`,
		percent: (fraction: number): string => `${Math.round(fraction * 100)}%`,
		offset: (n: number): string => (n > 0 ? `+${n}` : String(n)),
		mb: (n: number): string => `${n} MB`,
		threadsAuto: "Auto",
		variance: { low: "Low", medium: "Medium", high: "High" },
		motor: { slow: "Slow", natural: "Natural", fast: "Fast" },
		detected: "detected",
	},
	stepper: { decrease: "−", increase: "+", decreaseLabel: "Decrease", increaseLabel: "Increase" },
	voice: { default: "System default" },
	account: {
		noKey: "No key",
		plan: (renews: string): string => `Pro · renews ${renews}`,
		planNoExpiry: "Pro",
		planInactive: "No active plan",
		manageDevices: "Manage devices",
		device: (platform: string, browser: string): string => `${platform} · ${browser}`,
		browser: (version: string): string => `Chrome ${version}`,
		browserUnknown: "Chrome",
		platformUnknown: "This device",
	},
	advanced: {
		exportTimingLog: "Export timing log",
		exported: (n: number): string => `Exported ${n} timing entries`,
		exportFailed: "Couldn't export the timing log.",
		resetAll: "Reset all settings",
	},
	tc: { bullet: "bullet", blitz: "blitz", rapid: "rapid", classical: "classical" },
} as const;

// ── Task 24: Live view ─────────────────────────────────────────────────────────────────────
/** Strings the Live view adds to Appendix F §7.2 (§4.4 anatomy, §9.7 hand state, §13.6 band). */
export const COPY_LIVE = {
	secondary: "Session",
	configuration: (highlight: boolean, autoqueue: boolean): string =>
		`Highlight ${highlight ? COPY.common.on : COPY.common.off} · Auto-queue ${autoqueue ? COPY.common.on : COPY.common.off}`,
	/** Your row when the site gives no display name. */
	you: "You",
	cancel: "Cancel",
	strength: {
		header: "Strength",
		rating: "Target rating",
		chip: (elo: number, persona: string): string => `${elo} · ${persona}`,
		modes: { "engine-elo": "Engine", "persona-sampling": "Persona", hybrid: "Hybrid" },
		modeLabel: "Selection",
	},
	lines: {
		count: (n: number): string => `${n}`,
		countLabel: "Lines shown",
	},
	hand: {
		label: "Hand",
		resting: "resting",
		exploring: "exploring",
		moving: "moving",
		paused: "paused",
		detached: "detached",
	},
	band: {
		stats: (top1: number, acpl: number): string => `${top1}% top-1 · ${acpl} ACPL`,
		target: (lo: number, hi: number, acplLo: number, acplHi: number): string =>
			`band ${lo}–${hi}% · ${acplLo}–${acplHi}`,
		warning: (games: number): string => `Outside the band for ${games} games`,
	},
	clock: { opponent: "Opponent clock", you: "Your clock" },
	executorLabel: "Executor",
	/** Session strip before the first measured move: no "% vs target" figure yet. */
	sessionNoStats: (games: number, avg: string): string => `${games} games · ${avg}s avg move`,
} as const;
