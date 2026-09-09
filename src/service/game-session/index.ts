/**
 * The service worker's game stack (Task 30): the per-tab `GameSession`, its
 * §3.2 recommendation pipeline and ponder controller, the §3.3 transition
 * table and the registry that owns them all and feeds the panel broadcaster.
 */

export type { PonderKind } from "./ponder";
export { PonderController } from "./ponder";
export type { RecommendationInput, RecommendationOutcome, SearchBudget } from "./recommendation";
export { estimatedThinkMs, RecommendationPipeline, searchBudget } from "./recommendation";
export type { SessionRegistryDeps } from "./registry";
export { SessionRegistry } from "./registry";
export type { GameSessionDeps, SessionCommand } from "./session";
export { COMMAND_NAMES, GameSession } from "./session";
export { EMPTY_STATS, foldGame, foldMove } from "./stats";
export { MoveWindow, previewSelections, selectedMultiplePieces } from "./telemetry";
export type { GameSessionEvent, Transition, TransitionInput } from "./transitions";
export {
	GAME_SESSION_EVENTS,
	GAME_SESSION_STATES,
	isLiveState,
	isMyTurnState,
	nextState,
	TRANSITIONS,
} from "./transitions";
