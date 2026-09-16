/**
 * Every user-visible string of the panel, transcribed once from Appendix F §7 (tone: crisp,
 * sentence case, no emojis, no exclamation marks). Parameterised strings are functions so the
 * numbers stay specific ("4.2s", "d18"). Views and components import from here; no string
 * literal shown to the user may live anywhere else under `src/panel/`.
 */

import { REMATCH } from "@core/constants/rematch";
import { RESIGN } from "@core/constants/resign";
import type { StrengthBand } from "@core/constants/ui";
import type { ChosenMove } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";

/** The one supported site, as the panel names it — defined once, like every other string here. */
const SITE = "chess.com";
/** The play button's label while armed and on hover alike (the countdown lives on the ring). */
const PLAY_NOW = "Play now";

export const COPY = {
	brand: {
		name: "sliced",
		product: "sliced.sh",
		tagline: `Chess assistant for ${SITE}`,
	},
	nav: { game: "Game", settings: "Settings", engine: "Engine", viewSwitch: "Panel navigation" },
	workspace: {
		connecting: "Connecting…",
		connectingBody: "Loading session and settings.",
		live: "Live",
		/** The Live view's eyebrow while the lobby hold is on: a board, but no game queued yet. */
		lobby: "Lobby · no game queued",
		yourTurn: "Your move",
		theirTurn: "Waiting…",
		setup: "Session setup",
		settingsTitle: "Settings",
		settingsBody: "Choose how sliced plays, moves and gives feedback. Changes save automatically.",
		engineTitle: "Engine diagnostics",
		engineBody: "Engine, input and timing status.",
		shortcuts: "Page shortcuts",
		playNow: PLAY_NOW,
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
		queueDelay: (remaining: string): string => `Next game in ${remaining}`,
		queueBreak: (remaining: string): string => `Session break · Next session in ${remaining}`,
		queueStarting: "Starting next game…",
		queueRetrying: "Retrying…",
		queueSearching: "Matchmaking…",
		/** The rematch step (2026-09-13): the offer is out; the ordinary queue follows at the deadline. */
		queueRematch: (seconds: string): string => `Rematch offered · queueing in ${seconds}s`,
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
		/** Where the recommended move came from (`ChosenMove.source`), one label per source. */
		sources: {
			"engine-elo": "Engine",
			sampled: "Persona",
			blunder: "Mistake",
			mate: "Mate",
			book: "Book",
			premove: "Premove",
			maia: "Maia",
		} satisfies Record<ChosenMove["source"], string>,
		/** Your move, a recommendation shown, but the hand is not armed: say how to arm it. */
		noteUnarmed: (key: string): string => `Arm before the game; ${key} toggles auto-play.`,
		// There is no "D" shortcut: the only control is the Settings view's Assistant toggle.
		disabled: "Assistant disabled",
		plan: (seconds: string, method: string, premove: boolean): string =>
			`Delay ${seconds}s · ${method}${premove ? " · premove" : ""}`,
		play: "Play move",
		playShort: "Play",
		/** Owner's 2026-09-11 call: no countdown in the label — the ring and the spoken label carry it. */
		armed: PLAY_NOW,
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
		card: (elo: number, band: string): string => `${elo} ${band}`,
		popoverFooter: "Applies from next move",
		/** Owner, 2026-09-15: seven categories (`STRENGTH_LABEL_BANDS` holds their floors). */
		bands: {
			casual: "Casual",
			club: "Club",
			advanced: "Advanced",
			expert: "Expert",
			master: "Master",
			elite: "Elite",
			championI: "Champion I",
			championII: "Champion II",
		} satisfies Record<StrengthBand, string>,
		warning: "High-strength range",
		smallNetwork: "Small NNUE",
		largeNetwork: "Large NNUE",
		networkCutoff: (elo: number): string => String(elo),
		networkDescription: (cutoff: number, max: number): string =>
			`Through ${cutoff}: Maia-3 on the small NNUE. Above ${cutoff}: Stockfish on the large NNUE. ${max}: maximum engine strength; approximate rating.`,
	},
	/** The persona is forced to `balanced`; the names remain for the Engine view's timing log. */
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
		waiting: "Auto-play waiting",
		waitingHint: "Starts when a game is ready. Turn off to cancel.",
		off: "Auto-play off",
		armTooltip: "Hold to arm auto-play",
		locked: "Locked",
	},
	session: (games: number, pct: number, avg: string): string =>
		`${games} games · ${pct}% top-1 · ${avg}s avg move`,
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
			/** The host runs the small-net build because the requested full build crashed twice. */
			fallback: "full build crashed · small net until restart",
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
		renew: "Renew at sliced.sh",
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
	execution: {
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
	/** The second rail: a practical "how close to winning" blend, from the owner's side. */
	advantage: {
		label: "Advantage, you against your opponent",
		valueText: (you: number, opponent: number): string =>
			`Advantage · ${you}% you, ${opponent}% opponent`,
	},
	ring: { remaining: (seconds: string): string => `in ${seconds}s` },
	footer: (version: string, build: string): string => `sliced v${version} · build ${build}`,
	/** Third-party notices under the footer (Task 34; the full texts are in docs/third-party.md). */
	notices: {
		engine: "Stockfish 19 · GPL-3.0 / AGPL-3.0 · lichess-org/stockfish-web",
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
			policy: "Human model",
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
		/** Which model picks the move at the current target rating (2026-09-11). */
		selection: {
			maia: (size: string): string => `Selection · Maia-3 · ${size}`,
			stockfishSmall: "Selection · Stockfish 19 · small net",
			stockfishFull: "Selection · Stockfish 19 · full net",
			/** One shipped size since 2026-09-13; the map stays total over `MaiaSize`. */
			maiaSizes: { "79m": "79M" },
		},
		/** The Maia-3 block: the active size, its last answer and the inference-time sparkline. */
		policy: {
			name: (size: string): string => `Maia-3 · ${size}`,
			inactive: "Stockfish policy at this rating",
			off: "Off",
			waiting: "No answer yet",
			answered: "Answering",
			fallback: "Engine policy for this move",
			sparkline: "Maia-3 inference time per move, last 60 moves",
			latency: (ms: string): string => `${ms} ms`,
			pick: (pct: string): string => `pick ${pct}%`,
			wdl: (w: string, d: string, l: string): string => `W ${w} · D ${d} · L ${l} · side to move`,
			/**
			 * The fidelity meters (2026-09-13, §3.2 of the human-move-selection ideas): how much of
			 * the move was Maia's and how much the wrapper's, per move, from `rec.maia`.
			 */
			meters: {
				history: "History",
				selfElo: "Asked at",
				entropy: "Entropy",
				railed: "Railed mass",
				unscored: "Unscored mass",
				kl: "KL from Maia",
				rank: "Rank",
				candidates: "Candidates",
			},
			historyValue: (plies: number, max: number): string => `${plies}/${max} plies`,
			eloValue: (elo: number): string => `${elo} Elo`,
			pctValue: (pct: string): string => `${pct}%`,
			rankValue: (rank: number, survivors: number): string => `${rank} of ${survivors}`,
			candidatesValue: (k: number, depth: number): string => `${k} @ depth ${depth}`,
			/** H7.1: the query carried fewer plies than the model's window, past the opening. */
			historyWarning: "History unavailable — the model sees one frame",
		},
		rows: {
			debugger: "Debugger",
			target: "Target",
			input: "Input mode",
			last: "Last action",
			license: "License",
		},
		site: SITE,
		target: (gameId: string): string => `${SITE} · game ${gameId}`,
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
			model: (head: string, band?: string): string => `model ${head}${band ? ` · ${band}` : ""}`,
			fallback: (reason: string): string => `fallback: ${reason}`,
			context: (elo: number, opponentSeconds: string): string =>
				`target ${elo} · opponent ${opponentSeconds}s`,
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
		session: (games: number, moves: number, avg: string | null): string =>
			`${games} games · ${moves} moves · ${avg === null ? "—" : `${avg}s`} avg move`,
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
		lastSession: "Statistics",
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

/** Settings layout, 2026-09-13: why `timing.respectBudget` has no row (`FORCED_SETTINGS`). */
export const RESPECT_BUDGET_FORCED =
	"The clock budget is always respected; the clock-free schedule stays as a code path.";
/** Settings layout, 2026-09-13: why `keybinds.global` has no row (`FORCED_SETTINGS`). */
export const KEYBIND_SCOPE_FORCED =
	"Chrome's own shortcuts (chrome://extensions/shortcuts) always work; the captured keybinds are page shortcuts, so there is no scope to switch.";

export const SETTINGS_COPY = {
	sections: {
		strength: "Strength",
		automation: "Play & sessions",
		timing: "Timing & movement",
		board: "Board feedback",
		panel: "Appearance & sound",
		keybinds: "Shortcuts",
		engine: "Performance",
		account: "Account",
		advanced: "Diagnostics",
	},
	sectionHelp: {
		strength: "",
		automation: "Start, stop and pace your playing sessions.",
		timing: "One move clock covers the wait, exploration and final release.",
		board: "Choose what appears on the board after each move.",
		panel: "Adjust this panel and the feedback you hear.",
		keybinds: "Use these shortcuts while the board or panel is active.",
		engine: "Balance analysis resources with the rest of your computer.",
		account: "Your license and device.",
		advanced: "Inspect behavior, export evidence or restore defaults.",
	},
	autoplay: {
		title: "Auto-play lives in Game",
		help:
			"One switch controls this game and keeps your choice for the next. Turn it off to stop automatic moves.",
		action: "Open Game",
	},
	fineTune: (value: string, custom: boolean): string =>
		`${custom ? "Custom" : "Fine-tune"} · ${value}`,
	choices: {
		pace: [
			{ id: "0.8", label: "Deliberate", description: "More time" },
			{ id: "1", label: "Natural", description: "Model pace" },
			{ id: "1.35", label: "Quick", description: "Less time" },
		],
		variety: [
			{ id: "0.4", label: "Steadier" },
			{ id: "1", label: "Varied" },
			{ id: "1.6", label: "Wide" },
		],
		longThink: [
			{ id: "0", label: "Off" },
			{ id: "1", label: "Natural" },
			{ id: "1.8", label: "More often" },
		],
		premove: [
			{ id: "0", label: "Off" },
			{ id: "0.5", label: "Balanced" },
			{ id: "1", label: "Eager" },
		],
		motor: [
			{ id: "0.8", label: "Measured" },
			{ id: "1", label: "Natural" },
			{ id: "1.25", label: "Swift" },
		],
		preview: [
			{ id: "0", label: "Off" },
			{ id: "1", label: "Occasional" },
			{ id: "2", label: "Frequent" },
		],
		input: [
			{ id: "auto", label: "Mixed", description: "Mostly drags" },
			{ id: "drag", label: "Drag", description: "Hold & release" },
			{ id: "click", label: "Click", description: "Piece, then square" },
		],
	},
	jump: "Settings categories",
	all: "All",
	rows: {
		enabled: {
			label: "Assistant",
			help: "Off stops analysis and auto-play. Re-arming required after enabling.",
		},
		"strength.targetElo": {
			label: "Target rating",
		},
		"strength.matchOpponentRating": {
			label: "Match opponent rating",
			help: "Uses the opponent rating plus persona offset each game.",
		},
		"strength.personaEloOffset": {
			label: "Persona offset",
			help: "Added to the opponent's rating when matching.",
		},
		"strength.useOpeningBook": {
			label: "Opening book",
			help: "Plays book moves for the first 8–12 moves.",
		},
		"timing.baseSpeed": {
			label: "Overall pace",
			help:
				"Controls total time from the opponent’s move to releasing your piece. Faster leaves less time for thinking and mouse actions; engine search time is unchanged.",
		},
		"timing.varianceScale": {
			label: "Timing variety",
			help: "Controls the spread between quick replies and slower decisions.",
		},
		"timing.longThinkFrequency": {
			label: "Long thinks",
			help: "How often to add a longer pause when the position and clock allow it.",
		},
		"timing.premoveTendency": {
			label: "Premoves",
			help:
				"Willingness to queue a reply before the opponent moves. Only eligible positions can produce a premove; this is not a percentage of all moves.",
		},
		"execution.inputMode": {
			label: "Move pieces with",
			help: "Drag pieces, click piece then square, or mix the two per move (mostly drags).",
		},
		"execution.motorSpeed": {
			label: "Pointer pace",
			help: "Changes the hand’s speed within the overall move time.",
		},
		"execution.previewSelectScale": {
			label: "Thinking selections",
			help:
				"Selects and releases a candidate piece while considering a move. Off skips these selections; it does not disable premoves.",
		},
		"execution.verifyMoves": { label: "Verify moves after playing" },
		"automation.resignLostGames": {
			label: "Resign lost games",
			help: `When armed, resigns a forced mate in ${RESIGN.maxMateIn} or fewer instead of playing it out.`,
		},
		"automation.autoQueue": {
			label: "Auto-queue",
			help: "Queues consecutive games in playing sessions. Breaks start after the current game ends.",
		},
		"automation.autoQueueSessionMinMinutes": {
			label: "Minimum session duration",
			help: "Session duration is sampled once between the minimum and maximum.",
		},
		"automation.autoQueueSessionMaxMinutes": { label: "Maximum session duration" },
		"automation.autoQueueBreakMinMinutes": {
			label: "Minimum session break",
			help:
				"Break duration is sampled once between sessions. Games within a session queue after a short pause.",
		},
		"automation.autoQueueBreakMaxMinutes": { label: "Maximum session break" },
		"automation.rematchTitled": {
			label: "Rematch titled players",
			help: `After a game against a titled opponent, offer one rematch (or accept theirs); if it is not taken within ${REMATCH.acceptTimeoutMs / 1000} s, queue normally.`,
		},
		"automation.highlightMoves": {
			label: "Highlight moves",
			help: "Marks the recommended move on the board.",
		},
		"automation.highlightStyle": { label: "Highlight style" },
		"automation.boardEffects": {
			label: "Board effects",
			help: "After every move, shows what it did — threats, checks, forks, captures.",
		},
		"automation.moveQualityChips": {
			label: "Move ratings",
			help: "Rates each move on its square — best, mistake, blunder. Off saves the extra searches.",
		},
		"automation.moveQualityChipsFor": {
			label: "Show ratings for",
			help: "Whose moves get a rating and its sound. Board effects still show for both sides.",
		},
		"automation.moveRatingSounds": {
			label: "Move rating sound effects",
			help: "Plays a sound when a brilliant, great, inaccuracy, mistake, or blunder rating appears.",
		},
		"automation.forcedMateSounds": {
			label: "Forced mate sound effects",
			help: "Plays a rising tone on each move of a forced mate, up to the checkmate.",
		},
		"keybinds.playMove": { label: COPY.keybind.actions.playMove },
		"keybinds.toggleAutoMove": { label: COPY.keybind.actions.toggleAutoMove },
		"keybinds.disable": { label: COPY.keybind.actions.disable },
		"keybinds.speakMove": { label: COPY.keybind.actions.speakMove },
		"display.evalBar": { label: "Position evaluation" },
		"engine.multiPv": {
			label: "Candidate lines",
			help: "Lines shown in Game; the engine searches at least this many.",
		},
		"display.uiSounds": {
			label: "Control sounds",
			help: "Feedback for settings and controls.",
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
		"display.reducedMotion": { label: "Animations" },
		"display.virtualCursor": {
			label: "Virtual pointer",
			help: "Blocks physical mouse input and shows a disabled system cursor while active.",
		},
		"display.cursorEffects": {
			label: "Pointer effects",
			help: "Press feedback and the trail behind the virtual pointer.",
		},
		"engine.threads": {
			label: "Engine threads",
			help: "Auto uses 8 threads, or every core when the device has fewer.",
		},
		"engine.hashMb": {
			label: "Analysis memory",
			help: "Memory for reusing positions. More can reduce repeated search; 64 MB is the default.",
		},
		"engine.depthCap": {
			label: "Search depth",
			help: "Automatic from active Elo. Search time remains limited by the clock.",
		},
		"advanced.logLevel": { label: "Debug log level" },
		"advanced.timingLogEnabled": {
			label: "Timing log",
			help: "Keeps plan / exec / verify entries for export.",
		},
	} satisfies Record<string, SettingsRowCopy>,
	options: {
		inputMode: { auto: "Auto", drag: "Drag", click: "Click" },
		highlightStyle: { squares: "Squares", arrows: "Arrows", both: "Both" },
		moveQualityChipsFor: { mine: "You", theirs: "Opponent", both: "Both" },
		theme: { dark: "Dark", light: "Light", system: "System" },
		reducedMotion: { system: "System", on: "Reduced", off: "Full" },
		logLevel: { silent: "Silent", error: "Error", warn: "Warn", info: "Info", debug: "Debug" },
	},
	format: {
		times: (x: number): string => `${x.toFixed(2)}×`,
		percent: (fraction: number): string => `${Math.round(fraction * 100)}%`,
		offset: (n: number): string => (n > 0 ? `+${n}` : String(n)),
		mb: (n: number): string => `${n} MB`,
		minutes: (n: number): string => `${n} min`,
		threadsAuto: "Auto",
		depthAuto: (depth: number) => `Auto · ${depth}`,
		variance: { low: "Low", medium: "Medium", high: "High" },
		motor: { slow: "Slow", natural: "Natural", fast: "Fast" },
		/** The preview-selection slider's 0 position. */
		previewOff: "Off",
		/** The accuracy offset in Elo: "+150", "0", "−150". */
		elo: (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0"),
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
		header: "Active strength",
		rating: "Target rating",
		chip: (elo: number, persona: string): string => `${elo} · ${persona}`,
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
		stats: (top1: number, loss: number, moves: number): string =>
			`${top1}% top-1 · ${loss} cp search loss · ${moves} moves`,
		target: (lo: number, hi: number, lossLo: number, lossHi: number, minMoves: number): string =>
			`Search-time root comparisons, not post-game ACPL or measured Elo. Reference ${lo}–${hi}% top-1 · ${lossLo}–${lossHi} cp. Warnings require ${minMoves}+ comparable choices per game and an uncertainty interval wholly outside the reference. Intervals are approximate noise guards; chess moves are correlated. Same rating band, strength settings and time control only.`,
		warning: (games: number): string => `${games} sampled games outside reference`,
	},
	clock: { opponent: "Opponent clock", you: "Your clock" },
	executorLabel: "Executor",
	/** Session strip before the first measured move: no "% vs target" figure yet. */
	sessionNoStats: (games: number, avg: string | null): string =>
		`${games} games · ${avg === null ? "—" : `${avg}s`} avg move`,
	timingSampleCount: (n: number): string =>
		`${n} measured turns, including analysis and input. Historical hand-only timing and queued premoves are excluded.`,
} as const;
