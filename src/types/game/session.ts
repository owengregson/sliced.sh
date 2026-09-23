/** The game session's state machine and the view of it the panel renders (§3.3). */

import type { EvalLine } from "@typedefs/engine";
import type { Color, PageKind, PositionSnapshot, Site, TimeControl } from "./board";
import type { ExecutionResult } from "./execution";

/** GameSession states incl. the `live` sub-states (§3.3). */
export type GameSessionState =
	| "idle"
	| "waiting-for-game"
	| "live:opponent-turn"
	| "live:my-turn:analysing"
	| "live:my-turn:recommended"
	| "live:my-turn:executing"
	| "game-over";

export interface GameSessionView {
	state: GameSessionState;
	gameId: string | null;
	site: Site | null;
	pageKind: PageKind;
	myColor: Color | null;
	sideToMove: Color | null;
	ply: number;
	clocks: PositionSnapshot["clocks"] | null;
	/** Epoch time at which the site's remaining clock values were captured. */
	clocksAt?: number;
	/** An armed move may be fast-forwarded through preparation, until its committed mouse-down. */
	canPlayNow?: boolean;
	/**
	 * Pending automatic matchmaking. dueAt is the next attempt's epoch time — during `rematch`
	 * (2026-09-13: a rematch offered to, or accepted from, a titled opponent) the moment the
	 * ordinary queue click follows if the next game has not started by then.
	 */
	autoQueue?: {
		dueAt: number;
		attempts: number;
		status: "waiting" | "break" | "retrying" | "searching" | "rematch";
	};
	/** Latest analysis for the current position, including opponent-turn pondering. Side-to-move POV. */
	evaluation?: {
		fen: string;
		eval: EvalLine["score"];
		wdl?: [number, number, number];
	};
	timeControl?: TimeControl;
	/**
	 * The lobby hold is on (present only when true): the tab is on `/play/online` with a board
	 * whose clocks have not moved, so no game has been queued yet and the hand stays off the mouse.
	 */
	lobbyHold?: boolean;
	hand: "resting" | "exploring" | "moving" | "paused" | "detached";
	lastExecution?: ExecutionResult;
}
