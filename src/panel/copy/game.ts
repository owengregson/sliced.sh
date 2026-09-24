/** The game surface: move card, lines, strength, auto-play toggle, clocks and the eval rails. */

import type { StrengthBand } from "@core/constants/ui";
import type { ChosenMove } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import { PLAY_NOW } from "./site";

export const MOVE_COPY = {
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
} as const;

export const LINES_COPY = {
	header: "Lines",
	empty: "No lines",
	depth: (d: number): string => `d${d}`,
} as const;

export const STRENGTH_COPY = {
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
} as const;

/** The persona is forced to `balanced`; the names remain for the Engine view's timing log. */
export const PERSONA_NAME_COPY = {
	cautious: "Cautious",
	balanced: "Balanced",
	aggressive: "Aggressive",
	blitz: "Blitz-demon",
} as const satisfies Record<PersonaId, string>;

export const TOGGLE_COPY = {
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
} as const;

export const SESSION_COPY = (games: number, pct: number, avg: string): string =>
	`${games} games · ${pct}% top-1 · ${avg}s avg move`;

export const TELEMETRY_COPY = {
	clean: "clean",
	blur: "blur seen",
	mouse: "mouse touched",
	label: "Telemetry",
} as const;

export const EXECUTOR_COPY = {
	attached: "Attached",
	detached: "Detached",
	notStarted: "Not started",
} as const;

export const CLOCK_COPY = { unavailable: "clock unavailable", unknown: "—:—" } as const;

export const EVAL_COPY = {
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
} as const;

/** The second rail: a practical "how close to winning" blend, from the owner's side. */
export const ADVANTAGE_COPY = {
	label: "Advantage, you against your opponent",
	valueText: (you: number, opponent: number): string =>
		`Advantage · ${you}% you, ${opponent}% opponent`,
} as const;

export const RING_COPY = { remaining: (seconds: string): string => `in ${seconds}s` } as const;
