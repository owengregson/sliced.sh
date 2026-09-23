/** The reporter's public records and its collaborators' surfaces. */

import type { GamePortCommand } from "@core/constants/messages";
import type { MoveListRating } from "@core/constants/move-quality";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import type { Scheduler } from "@core/util/scheduler";
import type { MoveQualityChipSide } from "@typedefs/settings";

/** The review engine surface this needs (`ReviewEngine` satisfies it). */
export interface ReviewSearcher {
	analyse(req: AnalysisRequest): AnalysisHandle;
	/** Shared engine admission; the session owns its per-tab lease independently of this reporter. */
	setPlayBusy?(owner: string, busy: boolean): void;
	/** Boot the engine without searching; rejects when it cannot start. */
	warm?(): Promise<void>;
}

/** A position and the history that reaches it (the engine sees repetitions). */
export interface ReviewedPosition {
	fen: string;
	history: { fen: string; moves: readonly string[] };
}

/** A move to classify: the position it is played in, the history root of that position, the move. */
export interface ClassifiedMove {
	/** Position before the move. */
	beforeFen: string;
	/** Root of the session's history for that position. */
	historyFen: string;
	/** Moves from `historyFen` up to, but not including, the move. */
	historyMoves: readonly string[];
	/** The move itself, in UCI. */
	uci: string;
	/** Ply index of `beforeFen` (0 = the start position). */
	ply: number;
	/** `true` when the move is known to come from the opening book; otherwise the books are asked. */
	inBook?: boolean;
}

/** Our own planned move, known before it is played (`prepare`). */
export interface PlannedMove {
	beforeFen: string;
	history: { fen: string; moves: readonly string[] };
	uci: string;
	ply: number;
	inBook?: boolean;
}

export interface LandedMove extends ClassifiedMove {
	/** The owner played it (picks the accent palette rather than the cool one). */
	mine: boolean;
}

/** The plies that produced a position: one, or two when a queued premove fired on the reply. */
export interface Arrival {
	moves: LandedMove[];
}

export interface BoardEffectsReporterDeps {
	/** `null` while no review engine is attached: the effects still go out, the rating does not. */
	reviewer(): ReviewSearcher | null;
	post(cmd: GamePortCommand): void;
	/** Persistent log ratings, independent of board-chip side and freshness. */
	annotate?: (rating: MoveListRating) => void;
	/**
	 * `Settings.automation.moveQualityChips`. `false`: the rays still go out, but nothing is
	 * reviewed or sent. Absent means on.
	 */
	chips?: () => boolean;
	/**
	 * `Settings.automation.boardEffects`: whether a batch carries the rays and the capture mark.
	 * `false` (owner, 2026-09-15: the two switches no longer depend on each other): ratings are
	 * reviewed and sent exactly as with it on, each chip beside an empty effect list, and a move
	 * with no chip to send posts nothing. Absent means on.
	 */
	rays?: () => boolean;
	/**
	 * `Settings.automation.moveQualityChipsFor`: whose moves carry the chip. A hidden side's moves
	 * still post their effects — without `quality`, so no rating sound either — and are neither
	 * delivered nor dropped. Both sides' positions are still reviewed: every frame is also a half
	 * of the other side's verdicts, and our plan's result is the opponent's next "before". Absent
	 * means both.
	 */
	chipsFor?: () => MoveQualityChipSide;
	/** Opening-book moves for a position (`BookPolicy.bookMoves`); absent = no Book verdicts. */
	bookMoves?: (fen: string) => Promise<readonly string[]>;
	/** The rating a mover is graded at (chess.com's expected points depend on it). */
	rating?: (mine: boolean) => number | undefined;
	scheduler: Scheduler;
	now: () => number;
}

/** Why a landed move ended without a chip. */
export type DropReason = "no-frame" | "shallow" | "unscored" | "stale" | "failed" | "no-reviewer";

export interface VerdictStats {
	delivered: number;
	dropped: Record<string, number>;
}
