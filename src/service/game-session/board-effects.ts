/**
 * Board effects and move ratings for every landed move (owner's briefs, 2026-09-13 / 2026-09-14).
 *
 * The effect list is pure chess and goes out the moment a move lands. The rating is chess.com's
 * Game Review verdict (`classifyMoveQuality`), and it rests **only** on review frames: complete
 * MultiPV searches by the dedicated full-network review engine (`ReviewEngine`), never on the
 * playing engine's strength-limited, shaped or shallow lines.
 *
 * On time, not after the fact. One frame per position answers both halves of a verdict, so the
 * reporter keeps a small store of frames and a single review search in flight, always on the most
 * urgent position still short of `REVIEW.targetDepth`:
 *
 *   0  a landed move's missing half — the position it was played from, or the position it made
 *   1  the current position (the side to move is thinking: it is the next move's "before")
 *   2  the result of our planned move (the opponent's next "before", searched while we wait out
 *      the human think time)
 *   3  the results of the likeliest replies (the current frame's top lines), once the current
 *      position is final — so the opponent's move and our answer to it are ready in advance
 *
 * A more urgent need stops the search in flight; what it completed stays in the store and the
 * position is picked up again later. A landed move publishes when its frames reach
 * `REVIEW.targetDepth`, or after `REVIEW.landedWaitMs` from frames at `REVIEW.publishDepth` — a
 * late rating carries only its chip, so it cannot delay or replay the rays.
 * `setPlayBusy` suspends search and classification only during foreground preparation. Input
 * activity gates classification separately; background search keeps producing frames. Heavy
 * classification yields between jobs and admits work before the caller's input lead boundary.
 * Existing verdicts, forced/checkmate marks and rays publish immediately. Two live plies get
 * board effects; older unresolved plies continue at low priority for the persistent move log.
 */

import { boardEffectsFor } from "@core/chess/board-effects";
import { loadPosition } from "@core/chess/fen";
import { positionKey } from "@core/chess/history";
import { applyMoves, legalMoves, playUci, uciToSan } from "@core/chess/san";
import type { GamePortCommand } from "@core/constants/messages";
import {
	type MoveListRating,
	type MoveQualityMark,
	MOVE_QUALITY as Q,
} from "@core/constants/move-quality";
import { BRILLIANT, MOVE_CLASSIFICATION, REVIEW, reviewRetryDelayMs } from "@core/constants/review";
import {
	classifyMoveQuality,
	forcedMoveVerdict,
	type MoveQualityVerdict,
	passedBrilliantGates,
	type ReviewFrame,
	reviewLines,
} from "@core/engine/move-quality";
import type { AnalysisHandle, AnalysisPriority, AnalysisRequest } from "@core/engine/types";
import { log } from "@core/logger";
import { rankedLines } from "@core/strength/quality";
import { newId } from "@core/util/ids";
import type { Scheduler } from "@core/util/scheduler";
import type { Square } from "@typedefs/game";
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

/** Placement, side to move and castling/ep rights — what "the same position" means here. */
function boardKey(fen: string): string {
	return positionKey(fen);
}

/** Halfmove count separates repetitions and positions approaching the fifty-move draw. */
function reviewKey(fen: string): string {
	return fen.trim().split(/\s+/).slice(0, 5).join(" ");
}

function uciOf(fen: string, from: Square, to: Square): string | null {
	const base = `${from}${to}`;
	const legal = legalMoves(fen);
	if (legal.includes(base)) return base;
	return legal.find((m) => m.startsWith(base)) ?? null;
}

/**
 * The plies that took the board from `beforeFen` to `afterFen`, given the site's last-move
 * marking. Usually one. Two when a queued premove fired the instant the opponent moved (Fix F):
 * the marking is *our* move, played from a position this session never saw, so the opponent's
 * reply is recovered by trying every legal one. `null` when neither reading holds.
 */
export function landedPlies(
	beforeFen: string,
	last: { from: Square; to: Square },
	afterFen: string
): string[] | null {
	const direct = uciOf(beforeFen, last.from, last.to);
	if (direct !== null) return [direct];
	const want = boardKey(afterFen);
	for (const reply of legalMoves(beforeFen)) {
		const middle = applyMoves(beforeFen, [reply]);
		if (middle === null) continue;
		const ours = uciOf(middle, last.from, last.to);
		if (ours === null) continue;
		const both = applyMoves(middle, [ours]);
		if (both !== null && boardKey(both) === want) return [reply, ours];
	}
	return null;
}

interface StoredFrame extends ReviewFrame {
	/** The search for this position ran to its end: nothing deeper is coming. */
	done: boolean;
}

/** The mover's previous `mate` rating in a sequence, as its sound was pitched. */
export interface MateNote {
	/** Moves to checkmate, that move included. */
	mateIn: number;
	/** The semitones its sound was given. */
	semitones: number;
}

/**
 * The forced-mate pitch of a move `mateIn` moves from checkmate (1 = the checkmate), in semitones
 * from `forced.mp3`: `MOVE_QUALITY.mateTopSemitones` at the checkmate, one `mateSemitoneStep`
 * lower per move further out, never below `mateMinSemitones` nor above the top.
 */
export function matePitch(mateIn: number): number {
	const pitch = Q.mateTopSemitones - (mateIn - 1) * Q.mateSemitoneStep;
	return Math.min(Q.mateTopSemitones, Math.max(Q.mateMinSemitones, pitch));
}

/**
 * The semitones a `mate` rating's sound plays at, given the same mover's previous move in the
 * sequence (owner, 2026-09-15). The checkmate is always the top step. A sequence starting here,
 * making progress, or restarting because mate grew further away plays `matePitch(mateIn)`. A
 * tangential move — mate exactly as far away as before — plays the average of the previous pitch
 * and the next step's, so repeated ones creep upward and never pass that step.
 */
export function mateSemitones(mateIn: number, previous?: MateNote): number {
	if (mateIn <= 1) return Q.mateTopSemitones;
	if (previous === undefined || mateIn !== previous.mateIn) return matePitch(mateIn);
	return (previous.semitones + matePitch(mateIn - 1)) / 2;
}

/**
 * A checkmate on the board, rated as the classifier rates one — `mate`, mate in 1, above the whole
 * ladder — without waiting for a review frame; nothing is graded, as for a forced move.
 */
function checkmateVerdict(): MoveQualityVerdict {
	return { ...forcedMoveVerdict(), quality: "mate", mateIn: 1 };
}

/** A frame no further search will improve on. */
function final(frame: StoredFrame | undefined): boolean {
	return frame !== undefined && (frame.done || frame.depth >= REVIEW.targetDepth);
}

/** A position the reporter wants searched, and how urgently (0 = most). */
interface Want {
	key: string;
	root: string;
	moves: string[];
	urgency: number;
}

interface ActiveSearch {
	key: string;
	urgency: number;
	handle: AnalysisHandle;
	stopping: boolean;
}

/** One classification: a planned or landed move, and what still stands between it and a chip. */
interface VerdictJob {
	key: string;
	move: ClassifiedMove;
	mine: boolean;
	beforeKey: string;
	/** The position after the move, `null` when it is illegal. */
	after: { key: string; fen: string } | null;
	/** The position before the previous ply (Miss), when the history reaches back that far. */
	previousKey: string | null;
	/** Set once the move landed; effects have already been posted independently. */
	landed: { at: number } | null;
	/** The position had exactly one legal move: rated `forced` at once, no review needed. */
	forced: boolean;
	/**
	 * The move checkmates: rated `mate` at once — ahead of `forced`, so the final move of a mating
	 * sequence always carries its chip and its top-step sound.
	 */
	checkmate: boolean;
	/** Opening-book membership; `undefined` while the books are being read. */
	book: boolean | undefined;
	verdict: MoveQualityVerdict | null;
	delivered: boolean;
	boardDropped: boolean;
	blocker: DropReason;
	closed: boolean;
	timer: unknown;
}

export class BoardEffectsReporter {
	private generation = 0;
	private playBusy = false;
	private inputBusy = false;
	private availableUntil: number | null = null;
	private classificationTimer: unknown = null;
	private readonly classifications = new Set<VerdictJob>();
	private readonly frames = new Map<string, StoredFrame>();
	/** The last `MOVE_QUALITY.landedWindow` landed moves, oldest first. */
	private landed: VerdictJob[] = [];
	private readonly archive = new Map<number, VerdictJob>();
	private readonly annotated = new Map<number, VerdictJob>();
	/** The job started by `prepare()` for our planned move, waiting for it to land. */
	private prepared: VerdictJob | null = null;
	private current: ReviewedPosition | null = null;
	private active: ActiveSearch | null = null;
	/** After a failed search, nothing is issued before this time (and a timer pumps then). */
	private retryAt = 0;
	private retryTimer: unknown = null;
	/** Review searches that failed in a row: the step of `REVIEW.retryBackoffMs` to wait. */
	private failures = 0;
	/** `report()` is assembling its first batch: a rating found now ships inside it. */
	private reporting = false;
	private readonly counters: VerdictStats = { delivered: 0, dropped: {} };
	/** Per ply of a `mate` rating: its distance to mate and its sound's pitch (`mateSemitones`). */
	private readonly mateNotes = new Map<number, MateNote>();
	/** Plies whose move passed every brilliant gate (`BRILLIANT.sequencePlies` reads them). */
	private readonly sacrificePlies = new Set<number>();
	private disposed = false;

	constructor(private readonly deps: BoardEffectsReporterDeps) {}

	/** Foreground preparation alone suspends search; preserve evidence from cooperative stop. */
	setPlayBusy(busy: boolean): void {
		if (this.disposed || this.playBusy === busy) return;
		this.playBusy = busy;
		if (busy) {
			const active = this.active;
			if (active && !active.stopping) {
				active.stopping = true;
				void active.handle.stop().catch((error: unknown) => {
					log.debug("board effects: preparation stop failed", { error });
				});
			}
		} else {
			this.resolveAll();
			this.pump();
		}
	}

	/** Mouse-critical input blocks only synchronous classification, never background review. */
	setInputBusy(busy: boolean): void {
		if (this.disposed || this.inputBusy === busy) return;
		this.inputBusy = busy;
		if (!busy) this.resolveAll();
	}

	/** Absolute scheduler-clock lead boundary, already ahead of input; null is unlimited. */
	setAvailableUntil(until: number | null): void {
		if (this.disposed) return;
		this.availableUntil = until;
		this.scheduleClassification();
	}

	private canClassify(): boolean {
		return (
			!this.disposed &&
			!this.playBusy &&
			!this.inputBusy &&
			this.chipsOn() &&
			(this.availableUntil === null || this.deps.now() < this.availableUntil)
		);
	}

	/** At most one costly verdict per timer turn; every turn rechecks input admission. */
	private scheduleClassification(): void {
		if (this.classificationTimer !== null || !this.canClassify() || !this.classifications.size)
			return;
		this.classificationTimer = this.deps.scheduler.setTimeout(() => {
			this.classificationTimer = null;
			if (!this.canClassify()) return;
			let next = this.openJobs().find((job) => this.classifications.has(job));
			if (next?.landed) {
				// A premove recapture shares its square with the preceding move. Resolve that
				// predecessor first so its chip is not overwritten before it can be delivered.
				const at = this.landed.indexOf(next);
				const square = next.move.uci.slice(2, 4);
				const predecessor = this.landed
					.slice(0, Math.max(0, at))
					.find(
						(job) =>
							!job.closed &&
							!job.verdict &&
							this.classifications.has(job) &&
							job.move.uci.slice(2, 4) === square
					);
				if (predecessor) next = predecessor;
			}
			if (next) {
				this.classifications.delete(next);
				this.resolve(next, true);
			}
			this.scheduleClassification();
		}, 0);
	}

	/** `landedPlies`, reachable through the class for callers that only import it. */
	static landedPlies(
		beforeFen: string,
		last: { from: Square; to: Square },
		afterFen: string
	): string[] | null {
		return landedPlies(beforeFen, last, afterFen);
	}

	/** Chips delivered and landed moves that ended without one, by reason (for the tests). */
	stats(): VerdictStats {
		return { delivered: this.counters.delivered, dropped: { ...this.counters.dropped } };
	}

	/** The frame the reporter holds for `fen` (for the tests and the panel). */
	frameFor(fen: string): ReviewFrame | null {
		const frame = this.frames.get(reviewKey(fen));
		return frame ? { lines: frame.lines, depth: frame.depth } : null;
	}

	/**
	 * The position on the board now. Reviewed right away: it is the "before" of the next move and
	 * the "after" of the one that produced it, whichever side is thinking.
	 */
	observe(position: ReviewedPosition): void {
		if (this.disposed || !this.chipsOn()) return;
		this.current = position;
		this.pump();
	}

	/** Recover validated history when attaching midgame or after missed position events. */
	backfill(position: ReviewedPosition, ply: number): void {
		if (!this.deps.annotate || !this.chipsOn() || this.disposed) return;
		const chess = loadPosition(position.history.fen);
		if (!chess) return;
		const start = ply - position.history.moves.length;
		const trail: string[] = [];
		for (const [i, uci] of position.history.moves.entries()) {
			const index = start + i;
			const beforeFen = chess.fen();
			if (!playUci(chess, uci)) return;
			if (
				!this.annotated.has(index) &&
				!this.archive.has(index) &&
				!this.landed.some((job) => job.move.ply === index)
			) {
				const move = {
					beforeFen,
					historyFen: position.history.fen,
					historyMoves: [...trail],
					uci,
					ply: index,
				};
				const job = this.open(this.keyOf(move), move, false);
				job.landed = { at: this.deps.now() - REVIEW.landedWaitMs };
				this.archive.set(index, job);
			}
			trail.push(uci);
		}
		this.resolveAll();
		this.pump();
	}

	/** Finish log reviews after game over, without speculative work or late board effects. */
	finish(): void {
		if (!this.deps.annotate) {
			this.cancel();
			return;
		}
		for (const job of this.landed) {
			if (job.closed) continue;
			this.noteDrop(job, job.blocker);
			this.archive.set(job.move.ply, job);
		}
		this.landed = [];
		if (this.prepared) this.close(this.prepared, null);
		this.prepared = null;
		this.current = null;
		this.resolveAll();
		this.pump();
	}

	/**
	 * Our next move is decided: open its verdict now and review the position it will produce
	 * while the hand waits out the think time, so the chip is ready when the move lands. A repeat
	 * for the same (position, move) is a no-op; a different plan replaces the previous one.
	 */
	prepare(planned: PlannedMove): void {
		if (this.disposed || !this.chipsOn()) return;
		const move: ClassifiedMove = {
			beforeFen: planned.beforeFen,
			historyFen: planned.history.fen,
			historyMoves: planned.history.moves,
			uci: planned.uci,
			ply: planned.ply,
			...(planned.inBook === undefined ? {} : { inBook: planned.inBook }),
		};
		const key = this.keyOf(move);
		if (this.prepared?.key !== key) {
			if (this.prepared) this.close(this.prepared, null);
			this.prepared = this.open(key, move, true);
		}
		this.resolveAll();
		this.pump();
	}

	/**
	 * Report the moves that produced the current position. Returns at once — one `effects`
	 * command per landed move goes out synchronously (the opponent's first), before any review
	 * bookkeeping. Ratings travel separately and never carry rays to replay.
	 */
	report(arrival: Arrival): void {
		if (this.disposed || arrival.moves.length === 0) return;
		const rays = this.raysOn();
		// No book lookup, review-job construction or classification may hold up the visual move.
		if (rays)
			for (const move of arrival.moves)
				this.deps.post({
					kind: "effects",
					effects: boardEffectsFor({ fen: move.beforeFen, uci: move.uci }),
					mine: move.mine,
				});
		if (!this.chipsOn()) {
			// Rays only: nothing is opened, so nothing is reviewed and no chip can follow later.
			this.cancel();
			return;
		}
		const at = this.deps.now();
		const batches: VerdictJob[] = [];
		for (const move of arrival.moves) {
			const key = this.keyOf(move);
			if (!this.shows(move.mine) && !this.deps.annotate) {
				// A side whose ratings are hidden: its effects go out, nothing is tracked or counted. A
				// plan for this very move (ours, under "theirs") has done its job — the position it
				// made was reviewed for the opponent's reply — and closes quietly.
				if (this.prepared?.key === key) {
					this.close(this.prepared, null);
					this.prepared = null;
				}
				continue;
			}
			const reviewed = this.annotated.get(move.ply);
			if (reviewed?.delivered) {
				continue;
			}
			const archived = this.archive.get(move.ply) ?? reviewed;
			let job: VerdictJob;
			if (this.prepared?.key === key && !this.prepared.closed) {
				// The move we planned is the move that landed: its rating is ready or on its way.
				job = this.prepared;
				this.prepared = null;
			} else if (archived?.key === key) {
				job = archived;
				job.closed = false;
				this.archive.delete(move.ply);
				job.mine = move.mine;
			} else {
				job = this.open(key, move, move.mine);
			}
			job.landed = { at };
			job.timer = this.deps.scheduler.setTimeout(() => {
				job.timer = null;
				this.resolve(job);
				this.pump();
			}, REVIEW.landedWaitMs);
			this.landed.push(job);
			batches.push(job);
		}
		if (this.prepared) {
			// A plan for a move we did not play: abandoned, never counted (it never landed).
			log.debug("board effects: prepared rating discarded, a different move landed", {
				planned: this.prepared.move.uci,
			});
			// Its pitch was never played: the next move of ours must not count it as tangential.
			this.mateNotes.delete(this.prepared.move.ply);
			this.close(this.prepared, null);
			this.prepared = null;
		}
		this.trimLanded();
		// Resolve cheap/cached verdicts now; even these follow the already posted effects.
		this.reporting = true;
		try {
			this.resolveAll();
		} finally {
			this.reporting = false;
		}
		for (const job of batches) {
			if (job.verdict) this.publishAnnotation(job);
			if (job.verdict && !job.delivered && this.shows(job.mine)) {
				job.delivered = true;
				this.counters.delivered += 1;
				this.close(job, null);
				this.deps.post({ kind: "effects", effects: [], mine: job.mine, ...this.mark(job) });
			}
			// With the rays off a move whose chip is not decided yet posts nothing now: an empty batch
			// would draw nothing, and its chip, if one comes, follows on its own (`deliver`).
		}
		this.pump();
	}

	/**
	 * The board no longer carries the moves being rated (the game is over, the setting is off, a
	 * new game): stop the review search and orphan every rating, prepared or landed.
	 */
	cancel(): void {
		this.generation += 1;
		if (this.classificationTimer !== null) this.deps.scheduler.clearTimeout(this.classificationTimer);
		this.classificationTimer = null;
		this.classifications.clear();
		for (const job of this.archive.values()) this.close(job, null);
		this.archive.clear();
		this.annotated.clear();
		for (const job of this.landed) this.close(job, job.blocker);
		this.landed = [];
		if (this.prepared) this.close(this.prepared, null);
		this.prepared = null;
		this.current = null;
		const active = this.active;
		this.active = null;
		if (active) void active.handle.stop();
		this.frames.clear();
		this.mateNotes.clear();
		this.sacrificePlies.clear();
		if (this.retryTimer !== null) this.deps.scheduler.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.retryAt = 0;
	}

	/**
	 * A page where a game is played opened: start booting the review engine now, so the first
	 * rating does not also wait for the full network to load. Nothing is searched, and a boot that
	 * fails is left to the back-off.
	 */
	warm(): void {
		if (this.disposed || this.playBusy || !this.chipsOn() || this.deps.now() < this.retryAt) return;
		const reviewer = this.deps.reviewer();
		if (!reviewer?.warm) return;
		reviewer.warm().catch((error: unknown) => {
			log.debug("board effects: the review engine did not warm up", { error });
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.cancel();
		this.disposed = true;
	}

	private chipsOn(): boolean {
		return this.deps.chips?.() !== false;
	}

	private raysOn(): boolean {
		return this.deps.rays?.() !== false;
	}

	/** Whether a move by this side (`mine` = the owner's) carries a chip (`chipsFor`). */
	private shows(mine: boolean): boolean {
		const side = this.deps.chipsFor?.() ?? "both";
		return side === "both" || (side === "mine") === mine;
	}

	private keyOf(move: ClassifiedMove): string {
		return `${move.ply}|${reviewKey(move.beforeFen)}|${move.uci}`;
	}

	private open(key: string, move: ClassifiedMove, mine: boolean): VerdictJob {
		const afterFen = applyMoves(move.beforeFen, [move.uci]);
		const previousRoot =
			move.historyMoves.length > 0
				? applyMoves(move.historyFen, move.historyMoves.slice(0, -1))
				: null;
		const job: VerdictJob = {
			key,
			move,
			mine,
			beforeKey: reviewKey(move.beforeFen),
			after: afterFen === null ? null : { key: reviewKey(afterFen), fen: afterFen },
			previousKey: previousRoot === null ? null : reviewKey(previousRoot),
			forced: legalMoves(move.beforeFen).length === 1,
			checkmate: afterFen !== null && loadPosition(afterFen)?.isCheckmate() === true,
			landed: null,
			book: move.inBook === true ? true : undefined,
			verdict: null,
			delivered: false,
			boardDropped: false,
			blocker: "no-frame",
			closed: false,
			timer: null,
		};
		if (job.book === undefined) {
			const lookup = this.deps.bookMoves;
			if (!lookup) job.book = false;
			else
				void lookup(move.beforeFen).then(
					(moves) => {
						job.book = moves.includes(move.uci);
						this.resolve(job);
					},
					(error: unknown) => {
						log.debug("board effects: book lookup failed", { error });
						job.book = false;
						this.resolve(job);
					}
				);
		}
		return job;
	}

	private mark(job: VerdictJob): { quality: MoveQualityMark } {
		const verdict = job.verdict;
		const square = job.move.uci.slice(2, 4) as Square;
		if (verdict?.quality !== "mate" || verdict.mateIn === null)
			return { quality: { square, quality: verdict?.quality ?? "good" } };
		const semitones = this.mateNotes.get(job.move.ply)?.semitones ?? mateSemitones(verdict.mateIn);
		return { quality: { square, quality: "mate", mateSemitones: semitones } };
	}

	/** The same side's move within `BRILLIANT.sequencePlies` before `ply` passed the brilliant gates. */
	private recentSacrifice(ply: number): boolean {
		for (let back = 2; back <= BRILLIANT.sequencePlies; back += 2)
			if (this.sacrificePlies.has(ply - back)) return true;
		return false;
	}

	/**
	 * Record a `mate` rating's pitch against the mover's previous move (two plies back):
	 * `mateSemitones` tells progress, a tangential move and a restart apart.
	 */
	private noteMate(job: VerdictJob): void {
		const mateIn = job.verdict?.quality === "mate" ? job.verdict.mateIn : null;
		if (mateIn === null) {
			this.mateNotes.delete(job.move.ply);
			return;
		}
		const previous = this.mateNotes.get(job.move.ply - 2);
		this.mateNotes.set(job.move.ply, { mateIn, semitones: mateSemitones(mateIn, previous) });
	}

	/** Close a job; a landed move closing without a chip is logged and counted. */
	private close(job: VerdictJob, reason: DropReason | null): void {
		if (job.closed) return;
		job.closed = true;
		this.classifications.delete(job);
		if (job.timer !== null) {
			this.deps.scheduler.clearTimeout(job.timer);
			job.timer = null;
		}
		this.noteDrop(job, reason);
	}

	/** Losing board freshness does not discard the persistent review. Count it once. */
	private noteDrop(job: VerdictJob, reason: DropReason | null): void {
		if (job.boardDropped) return;
		// A side hidden since its move landed is not a missing chip: nothing is counted for it.
		if (reason === null || job.delivered || !job.landed || !this.shows(job.mine)) return;
		job.boardDropped = true;
		this.counters.dropped[reason] = (this.counters.dropped[reason] ?? 0) + 1;
		log.debug("board effects: no rating for the landed move", {
			uci: job.move.uci,
			ply: job.move.ply,
			mine: job.mine,
			reason,
		});
	}

	private openJobs(): VerdictJob[] {
		const jobs = this.landed.filter((job) => !job.closed && !job.verdict).reverse();
		if (this.prepared && !this.prepared.closed && !this.prepared.verdict) jobs.push(this.prepared);
		jobs.push(...[...this.archive.values()].filter((job) => !job.closed && !job.verdict));
		return jobs;
	}

	private trimLanded(): void {
		while (this.landed.length > Q.landedWindow) {
			const oldest = this.landed.shift();
			if (oldest && !oldest.closed && !oldest.verdict && this.deps.annotate) {
				this.noteDrop(oldest, oldest.blocker);
				this.archive.set(oldest.move.ply, oldest);
			} else if (oldest) this.close(oldest, oldest.blocker);
		}
	}

	private resolveAll(): void {
		for (const job of this.openJobs()) this.resolve(job);
	}

	/** Classify `job` from the frames held now; a landed job's rating is posted at once. */
	private resolve(job: VerdictJob, admitted = false): void {
		if (job.closed || job.verdict || this.disposed) return;
		if (job.checkmate) {
			// Checkmate is on the board: the last move of its sequence is rated, and sounds on the top
			// step, the moment it lands — also as the only legal move, or with no review frame ready.
			job.verdict = checkmateVerdict();
			this.noteMate(job);
			this.sacrificePlies.delete(job.move.ply);
			if (job.landed && !this.reporting) this.deliver(job);
			return;
		}
		if (job.forced) {
			// The only legal move needs no review: its rating is known the moment it is played.
			job.verdict = forcedMoveVerdict();
			this.mateNotes.delete(job.move.ply);
			this.sacrificePlies.delete(job.move.ply);
			if (job.landed && !this.reporting) this.deliver(job);
			return;
		}
		// Board-known outcomes above are cheap. Frames alone are not a cached verdict: producing
		// a new rating below can run the costly sacrifice scans, so it must wait out live input.
		if (!admitted) {
			this.classifications.add(job);
			this.scheduleClassification();
			return;
		}
		const waited = job.landed !== null && this.deps.now() - job.landed.at >= REVIEW.landedWaitMs;
		const usable = (frame: StoredFrame | undefined): frame is StoredFrame =>
			frame !== undefined && (final(frame) || (waited && frame.depth >= REVIEW.publishDepth));
		const before = this.frames.get(job.beforeKey);
		if (!usable(before)) {
			job.blocker = before ? "shallow" : "no-frame";
			return;
		}
		if (before.depth < MOVE_CLASSIFICATION.minDepth) {
			// A review that ran to its end without reaching a depth worth grading.
			job.blocker = "shallow";
			return;
		}
		if (job.book === undefined) return;
		const after = job.after ? this.frames.get(job.after.key) : undefined;
		const previous = job.previousKey ? this.frames.get(job.previousKey) : undefined;
		const verdict = classifyMoveQuality({
			fen: job.move.beforeFen,
			uci: job.move.uci,
			before,
			after: usable(after) ? after : undefined,
			previous: previous && previous.depth >= REVIEW.publishDepth ? previous : undefined,
			moverRating: this.deps.rating?.(job.mine),
			inBook: job.book,
			recentSacrifice: this.recentSacrifice(job.move.ply),
		});
		if (!verdict) {
			job.blocker = after ? "shallow" : "unscored";
			return;
		}
		// A shallow candidate is still being reviewed. Do not freeze an ordinary badge before
		// its tactical gates have enough evidence; a completed shallow search can still publish.
		if (
			verdict.brilliant?.reason === "insufficient-evidence" &&
			(!final(before) || (this.needsAfter(job) && !final(after)))
		) {
			job.blocker = "shallow";
			return;
		}
		job.verdict = verdict;
		this.noteMate(job);
		if (passedBrilliantGates(verdict)) this.sacrificePlies.add(job.move.ply);
		else this.sacrificePlies.delete(job.move.ply);
		if (job.landed && !this.reporting) this.deliver(job);
	}

	private publishAnnotation(job: VerdictJob): void {
		if (!this.deps.annotate || !job.landed || !job.verdict || this.annotated.has(job.move.ply))
			return;
		const san = uciToSan(job.move.beforeFen, job.move.uci);
		if (!san) return;
		this.annotated.set(job.move.ply, job);
		this.deps.annotate({ ply: job.move.ply, san, quality: job.verdict.quality });
		this.archive.delete(job.move.ply);
	}

	/** A rating for a landed move that `report()` did not ship inside the first command. */
	private deliver(job: VerdictJob): void {
		if (job.closed || job.delivered || !job.landed || !job.verdict) return;
		this.publishAnnotation(job);
		if (!this.shows(job.mine)) {
			// The side's ratings were hidden after the move landed: no chip, and nothing counted.
			this.close(job, null);
			return;
		}
		const at = this.landed.indexOf(job);
		if (at < 0) {
			this.close(job, this.deps.annotate ? null : "stale");
			return;
		}
		const to = job.move.uci.slice(2, 4);
		for (const later of this.landed.slice(at + 1))
			if (later.move.uci.slice(2, 4) === to && later.delivered) {
				// A later move on the same square already has its chip there: an older one would cover
				// it. Until then the chips go out in the order the moves landed (a premove recapture).
				this.close(job, "stale");
				return;
			}
		job.delivered = true;
		this.counters.delivered += 1;
		this.close(job, null);
		// Effects were sent on arrival. A late badge cannot replay rays after another move landed.
		this.deps.post({ kind: "effects", effects: [], mine: job.mine, ...this.mark(job) });
	}

	/** The move's "after" position is needed: the "before" frame does not score the move itself. */
	private needsAfter(job: VerdictJob): boolean {
		if (!job.after || legalMoves(job.after.fen).length === 0) return false;
		const before = this.frames.get(job.beforeKey);
		return !reviewLines(before, MOVE_CLASSIFICATION.minDepth).some(
			(line) => line.pvUci[0] === job.move.uci
		);
	}

	/** Every position worth reviewing now, most urgent first (duplicates keep the first). */
	private wants(): Want[] {
		const out: Want[] = [];
		const seen = new Set<string>();
		const add = (key: string, root: string, moves: readonly string[], urgency: number): void => {
			if (seen.has(key)) return;
			seen.add(key);
			out.push({ key, root, moves: [...moves], urgency });
		};
		const halves = (job: VerdictJob, urgency: number, always: boolean): void => {
			add(job.beforeKey, job.move.historyFen, job.move.historyMoves, urgency);
			if (job.after && (always || this.needsAfter(job)))
				add(job.after.key, job.move.historyFen, [...job.move.historyMoves, job.move.uci], urgency);
		};
		for (const job of [...this.landed].reverse())
			if (!job.closed && !job.verdict && (this.shows(job.mine) || this.deps.annotate))
				halves(job, 0, false);
		const current = this.current;
		if (current) add(reviewKey(current.fen), current.history.fen, current.history.moves, 1);
		const prepared = this.prepared;
		if (prepared && !prepared.closed) halves(prepared, 2, true);
		for (const job of this.archive.values()) if (!job.closed && !job.verdict) halves(job, 3, false);
		if (current) {
			const frame = this.frames.get(reviewKey(current.fen));
			if (final(frame) && frame)
				for (const line of rankedLines(frame.lines).slice(0, REVIEW.speculativeReplies)) {
					const reply = line.pvUci[0];
					const next = reply ? applyMoves(current.fen, [reply]) : null;
					if (reply && next && legalMoves(next).length > 0)
						add(reviewKey(next), current.history.fen, [...current.history.moves, reply], 4);
				}
		}
		return out;
	}

	/** Keep the one review search on the most urgent position that is not final yet. */
	private pump(): void {
		if (this.disposed || this.playBusy || !this.chipsOn()) return;
		const reviewer = this.deps.reviewer();
		if (!reviewer) {
			for (const job of this.landed) if (!job.verdict) job.blocker = "no-reviewer";
			return;
		}
		if (this.deps.now() < this.retryAt) return;
		const wants = this.wants().filter((want) => !final(this.frames.get(want.key)));
		const next = wants[0];
		const active = this.active;
		if (active) {
			if (active.stopping) return;
			const wanted = wants.find((want) => want.key === active.key);
			if (wanted && !(next && next.urgency < active.urgency && next.key !== active.key)) {
				active.urgency = wanted.urgency;
				return;
			}
			active.stopping = true;
			void active.handle.stop();
			return;
		}
		if (next) this.issue(reviewer, next);
	}

	private issue(reviewer: ReviewSearcher, want: Want): void {
		const priority: AnalysisPriority =
			want.urgency === 0 ? "move" : want.urgency === 1 ? "ponder" : "panel";
		const req: AnalysisRequest = {
			id: newId(),
			fen: want.root,
			...(want.moves.length > 0 ? { moves: want.moves } : {}),
			multiPv: REVIEW.multiPv,
			limit: { depth: REVIEW.targetDepth, movetimeMs: REVIEW.movetimeMs },
			priority,
		};
		let handle: AnalysisHandle;
		try {
			handle = reviewer.analyse(req);
		} catch (error) {
			log.debug("board effects: review refused", { error });
			this.failed();
			return;
		}
		const active: ActiveSearch = { key: want.key, urgency: want.urgency, handle, stopping: false };
		const generation = this.generation;
		this.active = active;
		void this.follow(active);
		handle.result.then(
			(result) => {
				if (this.active === active) this.active = null;
				if (this.disposed || generation !== this.generation) return;
				if (result.status === "failed") {
					this.failed();
					return;
				}
				this.failures = 0;
				if (
					result.final.complete &&
					result.id === req.id &&
					result.final.id === req.id &&
					result.request.fen === req.fen &&
					(result.request.moves ?? []).join(" ") === (req.moves ?? []).join(" ")
				)
					this.store(active.key, result.final, result.status === "complete" && !active.stopping);
				this.resolveAll();
				this.pump();
			},
			(error: unknown) => {
				if (this.active === active) this.active = null;
				log.debug("board effects: review failed", { error });
				if (!this.disposed && generation === this.generation) this.failed();
			}
		);
	}

	/** Every complete iteration of the search in flight goes into the store as it arrives. */
	private async follow(active: ActiveSearch): Promise<void> {
		try {
			for await (const update of active.handle.updates) {
				if (this.disposed || this.active !== active) return;
				if (!update.complete || update.id !== active.handle.id) continue;
				this.store(active.key, update, false);
				this.resolveAll();
				this.pump();
			}
		} catch (error) {
			log.debug("board effects: review updates ended", { error });
		}
	}

	private store(key: string, frame: ReviewFrame, done: boolean): void {
		// Remember completed shallow searches too: they cannot grade moves, but forgetting the
		// exhausted budget would immediately queue the same hopeless position forever.
		const lines = reviewLines(frame, 0);
		if (lines.length === 0 && !done) return;
		const existing = this.frames.get(key);
		if (existing && existing.depth > frame.depth) {
			if (done) existing.done = true;
			return;
		}
		this.frames.delete(key);
		this.frames.set(key, {
			lines,
			depth: frame.depth,
			done: done || (existing?.done === true && existing.depth === frame.depth),
		});
		if (this.frames.size <= REVIEW.knownPositions) return;
		const keep = new Set(this.wants().map((want) => want.key));
		for (const job of this.openJobs()) if (job.previousKey) keep.add(job.previousKey);
		for (const oldest of this.frames.keys()) {
			if (this.frames.size <= REVIEW.knownPositions) break;
			if (!keep.has(oldest)) this.frames.delete(oldest);
		}
	}

	/**
	 * The review engine could not answer: mark the waiting ratings, back off along
	 * `REVIEW.retryBackoffMs` (longer only while it keeps failing), try again then.
	 */
	private failed(): void {
		for (const job of this.landed) if (!job.verdict) job.blocker = "failed";
		this.failures += 1;
		const wait = reviewRetryDelayMs(this.failures);
		this.retryAt = this.deps.now() + wait;
		if (this.retryTimer !== null) this.deps.scheduler.clearTimeout(this.retryTimer);
		this.retryTimer = this.deps.scheduler.setTimeout(() => {
			this.retryTimer = null;
			this.pump();
		}, wait);
	}
}
