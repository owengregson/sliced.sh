import { REMATCH } from "@core/constants/rematch";
import { RESIGN } from "@core/constants/resign";
import { KEYBIND_COPY } from "./controls";

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
		"strength.useTablebase": {
			label: "Endgame tablebase",
			help:
				"Asks the Lichess tablebase in endgames of 7 pieces or fewer. Perfect play at max strength, occasional at human ratings.",
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
		"automation.freeTitle": {
			label: "Free title",
			help: "Shows a title on your own player cards and profile, only in your browser.",
		},
		"automation.freeTitleBadge": { label: "Title" },
		"automation.moveQualityChips": {
			label: "Move ratings",
			help:
				"Rates moves on the board and keeps both players’ ratings in the move log. Off saves the extra searches.",
		},
		"automation.moveQualityChipsFor": {
			label: "Board ratings for",
			help: "Whose moves get a board badge and sound. The move log keeps ratings for both sides.",
		},
		"automation.moveRatingSounds": {
			label: "Move rating sound effects",
			help: "Plays a sound when a brilliant, great, inaccuracy, mistake, or blunder rating appears.",
		},
		"automation.forcedMateSounds": {
			label: "Forced mate sound effects",
			help: "Plays a rising tone on each move of a forced mate, up to the checkmate.",
		},
		"keybinds.playMove": { label: KEYBIND_COPY.actions.playMove },
		"keybinds.toggleAutoMove": { label: KEYBIND_COPY.actions.toggleAutoMove },
		"keybinds.disable": { label: KEYBIND_COPY.actions.disable },
		"keybinds.speakMove": { label: KEYBIND_COPY.actions.speakMove },
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
		freeTitleBadge: { GM: "GM", IM: "IM", NM: "NM", FM: "FM", CM: "CM" },
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
