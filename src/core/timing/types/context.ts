/** What the model is asked to plan from: the position, clocks and game, and the settings. */

import type { EvalLine } from "@typedefs/engine";
import type { Site } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";

/** Lichess convention on `base + 40·inc`; `"untimed"` when there is no clock (§8.4b item 1). */
export type TcClass = "bullet" | "blitz" | "rapid" | "classical" | "untimed";

/** The persona profile is the user's `Settings.strength.persona` (Appendix D §4 table in constants). */
export type PersonaProfile = PersonaId;

export interface TimingContext {
	fen: string;
	ply: number;
	/** UCI moves played so far this game (the last one is the opponent's reply). */
	moves: string[];
	myColor: "w" | "b";
	chosenMove: string;
	/** MultiPV lines at the feature depth, side-to-move POV. */
	lines: EvalLine[];
	evalBeforeOppMove: number | null;
	expectedOppReply: string | null;
	myClockMs: number;
	oppClockMs: number;
	/** `0` and `0` together mean an untimed game. */
	baseSec: number;
	incSec: number;
	oppThinkMsHistory: number[];
	myThinkMsHistory: number[];
	site: Site;
	targetElo: number;
	profile: PersonaProfile;
	engineReady: boolean;
	/**
	 * §7.3 / Task 30: the opening book answered for this position. The feature's other half —
	 * "we are playing the engine's best move early" — is derived from the lines; this is the
	 * book half, which only the session knows.
	 */
	inBook?: boolean;
	inputMethod: "drag" | "click";
	autoQueen: boolean;
	/** Original opponent-position arrival, even when planning runs after asynchronous preparation. */
	nowMs: number;
}

export type ReplanReason =
	/** A plan whose deadline has passed is re-delivered: fold the wait into the think so the §8.6
	 * row reports the hold the page actually saw, not the floor `schedule` would fit it to. */
	| "withheld-then-released"
	| "engine-changed"
	| "clock-jump"
	| "opponent-moved"
	| "blur"
	| "manual-now"
	| "emergency";

/**
 * The timing knobs the model runs on. Every leaf of `Settings["timing"]` except the speed one:
 * the user's `timing.baseSpeed` is a **speed** (higher = faster) and everything downstream —
 * `createMoveBudget`, the head's compensation, the cap — multiplies a **duration**, so the
 * reciprocal is taken once, at `timingSettingsFor` (`src/service/game-session/presets.ts`), and
 * what the model sees is named for what it is. Nothing here reads a "speed" that means slowness
 * (owner, 2026-09-15).
 */
export interface TimingSettings extends Omit<Settings["timing"], "baseSpeed"> {
	/**
	 * Duration multiplier on the human wait: `per-time-control gain / baseSpeed` (2026-09-15: the
	 * preset knob that stood beside the gain went with the timing presets).
	 * Above 1 the move takes longer, below 1 it takes less.
	 */
	moveTimeScale: number;
}

export interface GameMeta {
	targetElo: number;
	profile: PersonaProfile;
	baseSec: number;
	incSec: number;
	site: Site;
	gameId: string;
}
