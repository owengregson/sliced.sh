/**
 * `GameSession` transition table (Part I §3.3). The machine is data so the
 * tests can enumerate every `(state, event)` edge: `TRANSITIONS[state][event]`
 * is either the next state or a resolver (only `positionChanged`, whose target
 * depends on whose turn the new position is). A pair the table does not define
 * is a **no-op** — `nextState` returns `null` and logs a warning — which is how
 * genuinely impossible edges (a `handStarted` while `idle`, a `playNow` on the
 * opponent's turn) stay visible instead of silently reshaping the state.
 *
 * Two events are not literally named in §3.3's prose but belong to the same
 * three families it lists:
 *   - `hello` — the adapter event that opens a session on a supported page
 *     (`GamePortMessage.hello`), i.e. what moves `idle → waiting-for-game`;
 *   - `handStarted` — the executor result that reports the hand leaving rest,
 *     i.e. what moves `recommended → executing` on the *scheduled* path
 *     (`playNow` is the manual one).
 */

import { log } from "@core/logger";
import type { GameSessionState } from "@typedefs/game";

export const GAME_SESSION_STATES = [
	"idle",
	"waiting-for-game",
	"live:opponent-turn",
	"live:my-turn:analysing",
	"live:my-turn:recommended",
	"live:my-turn:executing",
	"game-over",
] as const satisfies readonly GameSessionState[];

export const GAME_SESSION_EVENTS = [
	// adapter
	"hello",
	"gameStarted",
	"positionChanged",
	"gameEnded",
	// user commands
	"playNow",
	"armAutoMove",
	"disarm",
	"disable",
	// executor results
	"handStarted",
	"executed",
	"failed",
	// tab lifecycle
	"tabRemoved",
	"navigated",
] as const;

export type GameSessionEvent = (typeof GAME_SESSION_EVENTS)[number];

export interface TransitionInput {
	/** `positionChanged` only: is the side to move in the new position ours? */
	myTurn?: boolean;
}

/** A constant target, or the target derived from the event's input. */
export type Transition = GameSessionState | ((input: TransitionInput) => GameSessionState);

type Row = Partial<Record<GameSessionEvent, Transition>>;

/** `positionChanged`: my turn opens a fresh analysis window, theirs is the ponder window. */
const onPosition = (input: TransitionInput): GameSessionState =>
	input.myTurn === true ? "live:my-turn:analysing" : "live:opponent-turn";

/** Edges every state shares: `disable` stops everything, the tab dying resets to `idle`. */
const COMMON: Row = {
	disable: "idle",
	tabRemoved: "idle",
};

const IDLE: Row = {
	...COMMON,
	hello: "waiting-for-game",
	gameStarted: "live:opponent-turn",
	// A position without a `gameStarted` (a reconnect into a game already in progress).
	positionChanged: onPosition,
	// Arming on a page with no session yet is the §13.4 "arm in the waiting view" path.
	armAutoMove: "waiting-for-game",
	navigated: "idle",
};

const WAITING: Row = {
	...COMMON,
	hello: "waiting-for-game",
	gameStarted: "live:opponent-turn",
	positionChanged: onPosition,
	gameEnded: "waiting-for-game",
	armAutoMove: "waiting-for-game",
	disarm: "waiting-for-game",
	navigated: "waiting-for-game",
};

/**
 * Live rows share everything except what the sub-state itself decides
 * (`hello`, `armAutoMove` and `disarm` are the state itself; `playNow`,
 * `handStarted`, `executed` and `failed` differ per sub-state).
 */
const LIVE_COMMON: Row = {
	...COMMON,
	gameStarted: "live:opponent-turn",
	positionChanged: onPosition,
	gameEnded: "game-over",
	navigated: "waiting-for-game",
};

const OPPONENT_TURN: Row = {
	...LIVE_COMMON,
	hello: "live:opponent-turn",
	armAutoMove: "live:opponent-turn",
	disarm: "live:opponent-turn",
	// A result that arrives after the position already moved on (verification lands late).
	executed: "live:opponent-turn",
	failed: "live:opponent-turn",
};

const ANALYSING: Row = {
	...LIVE_COMMON,
	hello: "live:my-turn:analysing",
	// The user asked to play before the engine answered: the session queues it.
	playNow: "live:my-turn:analysing",
	armAutoMove: "live:my-turn:analysing",
	disarm: "live:my-turn:analysing",
	executed: "live:opponent-turn",
	failed: "live:my-turn:analysing",
};

const RECOMMENDED: Row = {
	...LIVE_COMMON,
	hello: "live:my-turn:recommended",
	playNow: "live:my-turn:executing",
	armAutoMove: "live:my-turn:recommended",
	disarm: "live:my-turn:recommended",
	handStarted: "live:my-turn:executing",
	executed: "live:opponent-turn",
	failed: "live:my-turn:recommended",
};

const EXECUTING: Row = {
	...LIVE_COMMON,
	hello: "live:my-turn:executing",
	playNow: "live:my-turn:executing",
	armAutoMove: "live:my-turn:executing",
	// The hand was stopped mid-move; the recommendation for this position still stands.
	disarm: "live:my-turn:recommended",
	handStarted: "live:my-turn:executing",
	executed: "live:opponent-turn",
	failed: "live:my-turn:recommended",
};

const GAME_OVER: Row = {
	...COMMON,
	// A fresh `hello` (page kind re-detected, port reconnected) reopens the waiting view.
	hello: "waiting-for-game",
	gameStarted: "live:opponent-turn",
	// Post-mortem positions of the finished game do not restart it.
	positionChanged: "game-over",
	gameEnded: "game-over",
	armAutoMove: "game-over",
	disarm: "game-over",
	executed: "game-over",
	failed: "game-over",
	navigated: "waiting-for-game",
};

export const TRANSITIONS: Readonly<Record<GameSessionState, Row>> = Object.freeze({
	idle: IDLE,
	"waiting-for-game": WAITING,
	"live:opponent-turn": OPPONENT_TURN,
	"live:my-turn:analysing": ANALYSING,
	"live:my-turn:recommended": RECOMMENDED,
	"live:my-turn:executing": EXECUTING,
	"game-over": GAME_OVER,
});

/**
 * The state `event` leads to from `state`, or `null` when the table defines no
 * such edge (a no-op; the caller keeps its state and the pair is logged).
 */
export function nextState(
	state: GameSessionState,
	event: GameSessionEvent,
	input: TransitionInput = {}
): GameSessionState | null {
	const target = TRANSITIONS[state][event];
	if (target === undefined) {
		log.warn("game-session: no transition", { state, event });
		return null;
	}
	return typeof target === "function" ? target(input) : target;
}

export function isLiveState(state: GameSessionState): boolean {
	return state.startsWith("live:");
}

export function isMyTurnState(state: GameSessionState): boolean {
	return state.startsWith("live:my-turn:");
}
