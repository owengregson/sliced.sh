/**
 * Game-domain types shared across contexts (§3.3, §4.3, Appendix C §4).
 * Task 3 extends this file; later tasks import these names.
 *
 * The declarations live by domain in `./game/`; this file is the entry every importer uses.
 */

export type {
	ClockState,
	Color,
	GameMeta,
	GameResult,
	HighlightStyle,
	PageKind,
	PositionSnapshot,
	PromoPiece,
	Site,
	Square,
	TimeControl,
} from "./game/board";
export type { ExecutionResult } from "./game/execution";
export type { ChosenMove, MaiaMeters, Recommendation } from "./game/recommendation";
export type { GameSessionState, GameSessionView } from "./game/session";
export type {
	SessionQualityCohort,
	SessionQualityGame,
	SessionQualitySample,
	SessionStats,
} from "./game/stats";
