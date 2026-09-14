/**
 * Publish landed-move effects immediately and add a rating when sufficient scores arrive.
 * Recommendation, arrival, and live ponder/panel frames share the position-indexed score cache;
 * an unranked move uses the following position's score, flipped to the mover's perspective.
 * Complete background frames can therefore finish a verdict while the board stays unchanged.
 *
 * Dedicated low-priority searches remain a fallback. A late rating repeats its effect list so
 * the overlay adds the marker without replaying animations. Ratings remain eligible within the
 * landed window, unless a later move owns the same square. Cancellation clears pending jobs.
 */

import { boardEffectsFor } from "@core/chess/board-effects";
import { positionKey } from "@core/chess/history";
import { applyMoves, legalMoves } from "@core/chess/san";
import type { BoardEffect } from "@core/constants/board-effects";
import type { GamePortCommand } from "@core/constants/messages";
import { type MoveQualityMark, MOVE_QUALITY as Q } from "@core/constants/move-quality";
import { classifyMoveQuality, type MoveQualityVerdict } from "@core/engine/move-quality";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import { log } from "@core/logger";
import { rankedLines } from "@core/strength/quality";
import { newId } from "@core/util/ids";
import type { Eval, EvalLine } from "@typedefs/engine";
import type { Square } from "@typedefs/game";

/** The searcher surface this needs (`EngineController` satisfies it). */
export interface BoardEffectsSearcher {
	analyse(req: AnalysisRequest): AnalysisHandle;
}

/** A move to classify: the position it is played in, the history root of that position, the move. */
export interface ClassifiedMove {
	/** Position before the move. */
	beforeFen: string;
	/** Root of the session's history for that position (repetition-aware cache identity). */
	historyFen: string;
	/** Moves from `historyFen` up to, but not including, the move. */
	historyMoves: readonly string[];
	/** The move itself, in UCI. */
	uci: string;
	/** Ply index of `beforeFen` (0 = the start position). */
	ply: number;
	/** The move came out of the opening book; only our own moves can know. */
	inBook?: boolean;
}

/** Lines an existing search produced for a position: the referee's, the ponder's, a cache hit. */
export interface KnownLines {
	lines: readonly EvalLine[];
	/** The search ran with no `elo` (`UCI_LimitStrength false`). */
	fullStrength: boolean;
}

/** Our own planned move, known before it is played (`prepare`): the session's history root as is. */
export interface PlannedMove {
	beforeFen: string;
	history: { fen: string; moves: readonly string[] };
	uci: string;
	ply: number;
	inBook?: boolean;
	/** The own-move search's lines for `beforeFen`, when there was a search. */
	analysis?: KnownLines;
}

export interface LandedMove extends ClassifiedMove {
	/** The owner played it (picks the accent palette rather than the cool one). */
	mine: boolean;
}

/** Everything one position arrival says about the moves that produced it. */
export interface Arrival {
	/** The plies that landed, in order: one, or two when a queued premove fired on the reply. */
	moves: LandedMove[];
	/** Lines the session already holds for `moves[0].beforeFen` (the ponder's), any strength. */
	lines?: readonly EvalLine[];
	/**
	 * The `UCI_Elo` the session's own searches run at (absent = full strength). A position the
	 * session analysed at that strength answers from the cache when asked at the same strength.
	 */
	strengthElo?: number;
}

export interface BoardEffectsReporterDeps {
	/** `null` while no searcher is attached: the effects still go out, the verdict does not. */
	searcher(): BoardEffectsSearcher | null;
	post(cmd: GamePortCommand): void;
	/**
	 * `Settings.automation.moveQualityChips` (2026-09-13). `false`: the rays still go out, but no
	 * verdict is prepared, searched or sent — the chip is the one part of the effect layer that
	 * costs engine time. Absent means on.
	 */
	chips?: () => boolean;
}

/** Why a landed move ended without a chip. */
export type DropReason =
	| "no-line"
	| "shallow"
	| "unscored"
	| "superseded"
	| "stale"
	| "failed"
	| "no-searcher";

export interface VerdictStats {
	delivered: number;
	dropped: Record<string, number>;
}

/** Flip a score to the other side's point of view. */
function negate(score: Eval): Eval {
	if (score.mate !== undefined) return { mate: -score.mate };
	return { cp: -(score.cp ?? 0) };
}

/** Identity of a classification: the position the move is played in, and the move. */
function keyOf(move: ClassifiedMove): string {
	return `${positionKey(move.beforeFen)}|${move.uci}`;
}

/** Placement, side to move and castling/ep rights — what "the same position" means here. */
function boardKey(fen: string): string {
	return positionKey(fen);
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

interface Known extends KnownLines {
	depth: number;
}

/** One classification: a planned or landed move, and what still stands between it and a chip. */
interface VerdictJob {
	key: string;
	move: ClassifiedMove;
	mine: boolean;
	/** Position key after the move (where its "played" score comes from). */
	afterKey: string | null;
	/** Set once the move landed: the effect list its chip is sent beside. */
	landed: { effects: BoardEffect[] } | null;
	verdict: MoveQualityVerdict | null;
	delivered: boolean;
	/** Why it is not classified yet, and which half is missing. */
	blocker: DropReason;
	missing: "before" | "after" | null;
	/** Dedicated searches issued for each half — at most one per half, ever. */
	searched: { before: boolean; after: boolean };
	closed: boolean;
}

export class BoardEffectsReporter {
	/** Lines per position key, bounded to `MOVE_QUALITY.knownPositions` (oldest first). */
	private readonly known = new Map<string, Known>();
	/** The last `MOVE_QUALITY.landedWindow` landed moves, oldest first. */
	private landed: VerdictJob[] = [];
	/** The job started by `prepare()` for our planned move, waiting for it to land. */
	private prepared: VerdictJob | null = null;
	/** Dedicated searches in flight, by the position key they answer. */
	private readonly inFlight = new Map<string, AnalysisHandle>();
	private readonly counters: VerdictStats = { delivered: 0, dropped: {} };
	private disposed = false;

	constructor(private readonly deps: BoardEffectsReporterDeps) {}

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

	/**
	 * Lines an existing search produced for `fen`. Remembered for the last few positions and
	 * used for any classification that needs them — the "before" half of the move played from
	 * `fen`, the "played" half of the move that led to `fen`.
	 */
	supply(fen: string, lines: readonly EvalLine[], fullStrength: boolean): void {
		if (this.disposed || lines.length === 0) return;
		const key = boardKey(fen);
		const depth = rankedLines(lines)[0]?.depth ?? 0;
		const existing = this.known.get(key);
		if (existing && existing.depth > depth && !(fullStrength && !existing.fullStrength)) return;
		this.known.delete(key);
		this.known.set(key, { lines, fullStrength, depth });
		while (this.known.size > Q.knownPositions) {
			const oldest = this.known.keys().next().value;
			if (oldest === undefined) break;
			this.known.delete(oldest);
		}
		this.resolveAll();
	}

	/**
	 * Our next move is decided: classify it now, while the engine is idle and the hand is still
	 * waiting out the human think time, so the verdict is ready when the move lands. The
	 * recommendation's own lines answer when they were searched at full strength; otherwise the
	 * dedicated search runs now. A repeat for the same (position, move) is a no-op; a different
	 * plan replaces the previous one. Any landed move still waiting for lines gets its dedicated
	 * searches here too — this is the one moment the engine has nothing else to do.
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
		const key = keyOf(move);
		if (this.prepared?.key !== key) {
			if (this.prepared && !this.prepared.closed) {
				this.prepared.closed = true;
				log.debug("board effects: prepared verdict replaced by a new plan", {
					uci: this.prepared.move.uci,
					next: move.uci,
				});
			}
			this.prepared = this.open(key, move, true);
		}
		if (planned.analysis)
			this.supply(planned.beforeFen, planned.analysis.lines, planned.analysis.fullStrength);
		this.resolveAll();
		if (this.prepared && !this.prepared.verdict) this.searchMissing(this.prepared, undefined);
		for (const job of this.landed)
			if (!job.closed && !job.verdict) this.searchMissing(job, undefined);
	}

	/**
	 * Report the moves that produced the current position. Returns at once — one `effects`
	 * command per landed move goes out synchronously (the opponent's first), each with its verdict
	 * inside when that is already known; a verdict found later follows as its own command.
	 */
	report(arrival: Arrival): void {
		if (this.disposed || arrival.moves.length === 0) return;
		if (!this.chipsOn()) {
			// Rays only: nothing is opened, so nothing is searched and no chip can follow later.
			this.cancel();
			for (const move of arrival.moves)
				this.deps.post({
					kind: "effects",
					effects: boardEffectsFor({ fen: move.beforeFen, uci: move.uci }),
					mine: move.mine,
				});
			return;
		}
		const jobs: Array<{ job: VerdictJob; effects: BoardEffect[] }> = [];
		for (const move of arrival.moves) {
			const effects = boardEffectsFor({ fen: move.beforeFen, uci: move.uci });
			const key = keyOf(move);
			let job: VerdictJob;
			if (this.prepared?.key === key && !this.prepared.closed) {
				// The move we planned is the move that landed: its verdict is ready or on its way.
				job = this.prepared;
				this.prepared = null;
			} else {
				job = this.open(key, move, move.mine);
			}
			job.landed = { effects };
			this.landed.push(job);
			jobs.push({ job, effects });
		}
		if (this.prepared && !this.prepared.closed) {
			// A plan for a move we did not play: abandoned, never counted (it never landed).
			this.prepared.closed = true;
			log.debug("board effects: prepared verdict discarded, a different move landed", {
				planned: this.prepared.move.uci,
			});
		}
		this.prepared = null;
		while (this.landed.length > Q.landedWindow) {
			const evicted = this.landed.shift();
			if (evicted) this.close(evicted, evicted.missing === null ? "stale" : evicted.blocker);
		}
		const first = arrival.moves[0];
		if (arrival.lines && first) this.supply(first.beforeFen, arrival.lines, false);
		this.resolveAll();
		for (const { job, effects } of jobs) {
			const mine = job.mine;
			if (job.verdict && !job.delivered) {
				job.delivered = true;
				this.counters.delivered += 1;
				this.close(job, null);
				this.deps.post({ kind: "effects", effects, mine, ...this.mark(job.verdict, job.move) });
			} else {
				this.deps.post({ kind: "effects", effects, mine });
			}
		}
		// A "before" position nobody analysed is asked for at the session's own strength: a
		// position the session searched (a premove's) answers from the cache; anything else is a
		// best-effort search the next `move`/`ponder` request may supersede.
		for (const { job } of jobs)
			if (!job.closed && !job.verdict && job.missing === "before")
				this.searchMissing(job, arrival.strengthElo);
	}

	/**
	 * The board no longer carries the moves that were classified (the game is over, the setting is
	 * off, a new game): stop every search and orphan every verdict, prepared or landed.
	 */
	cancel(): void {
		// The reason is what still stood between the move and its chip, not the cancel itself.
		for (const job of this.landed) this.close(job, job.missing === null ? "stale" : job.blocker);
		this.landed = [];
		if (this.prepared) this.prepared.closed = true;
		this.prepared = null;
		for (const handle of this.inFlight.values()) void handle.stop();
		this.inFlight.clear();
		this.known.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.cancel();
		this.disposed = true;
	}

	private chipsOn(): boolean {
		return this.deps.chips?.() !== false;
	}

	private open(key: string, move: ClassifiedMove, mine: boolean): VerdictJob {
		const after = applyMoves(move.beforeFen, [move.uci]);
		return {
			key,
			move,
			mine,
			afterKey: after === null ? null : boardKey(after),
			landed: null,
			verdict: null,
			delivered: false,
			blocker: "no-line",
			missing: "before",
			searched: { before: false, after: false },
			closed: false,
		};
	}

	private mark(verdict: MoveQualityVerdict, move: ClassifiedMove): { quality: MoveQualityMark } {
		return { quality: { square: move.uci.slice(2, 4) as Square, quality: verdict.quality } };
	}

	/** Close a job; a landed move closing without a chip is logged and counted. */
	private close(job: VerdictJob, reason: DropReason | null): void {
		if (job.closed) return;
		job.closed = true;
		if (reason === null || job.delivered || !job.landed) return;
		this.counters.dropped[reason] = (this.counters.dropped[reason] ?? 0) + 1;
		log.debug("board effects: no chip for the landed move", {
			uci: job.move.uci,
			ply: job.move.ply,
			mine: job.mine,
			reason,
		});
	}

	private resolveAll(): void {
		for (const job of this.landed) this.resolve(job);
		if (this.prepared) this.resolve(this.prepared);
	}

	/** Try to classify `job` from the lines known now; on success post it if it has landed. */
	private resolve(job: VerdictJob): void {
		if (job.closed || job.verdict) return;
		const before = this.known.get(boardKey(job.move.beforeFen));
		// Before landing there is time for the full-strength search, so shaped lines are not
		// accepted yet; once landed, whatever the session has is better than nothing.
		if (!before || (!job.landed && !before.fullStrength)) {
			this.setBlocker(job, "no-line", "before");
			return;
		}
		const ranked = rankedLines(before.lines);
		const best = ranked[0];
		if (!best) {
			this.setBlocker(job, "no-line", "before");
			return;
		}
		if (best.depth < Q.minDepth) {
			this.setBlocker(job, "shallow", "before");
			return;
		}
		let playedScore: Eval | undefined;
		if (!ranked.some((line) => line.pvUci[0] === job.move.uci)) {
			const after = job.afterKey === null ? undefined : this.known.get(job.afterKey);
			const top = after ? rankedLines(after.lines)[0] : undefined;
			if (!after || !top) {
				this.setBlocker(job, "unscored", "after");
				return;
			}
			if (top.depth < Q.minDepth) {
				this.setBlocker(job, "shallow", "after");
				return;
			}
			playedScore = negate(top.score);
		}
		const verdict = classifyMoveQuality({
			fen: job.move.beforeFen,
			uci: job.move.uci,
			ply: job.move.ply,
			lines: before.lines,
			...(playedScore ? { playedScore } : {}),
			...(job.move.inBook === undefined ? {} : { inBook: job.move.inBook }),
		});
		if (!verdict) {
			this.setBlocker(job, "unscored", "after");
			return;
		}
		job.verdict = verdict;
		job.missing = null;
		if (job.landed) this.deliver(job);
	}

	private setBlocker(job: VerdictJob, blocker: DropReason, missing: "before" | "after"): void {
		// "superseded" is the more telling reason for the same missing half: a re-read of the same
		// shallow frame must not hide that the search which produced it was cut short.
		if (job.blocker === "superseded" && blocker === "shallow" && job.missing === missing) return;
		job.blocker = blocker;
		job.missing = missing;
	}

	/** A verdict for a landed move that `report()` did not ship inside the first command. */
	private deliver(job: VerdictJob): void {
		if (job.closed || job.delivered || !job.landed || !job.verdict) return;
		const at = this.landed.indexOf(job);
		if (at < 0) {
			this.close(job, "stale");
			return;
		}
		const to = job.move.uci.slice(2, 4);
		for (const later of this.landed.slice(at + 1))
			if (later.move.uci.slice(2, 4) === to) {
				// A later move landed on the same square: its chip is the one that belongs there.
				this.close(job, "stale");
				return;
			}
		job.delivered = true;
		this.counters.delivered += 1;
		this.close(job, null);
		// The same effect list, so the page's dedupe skips the rays it has already drawn and only
		// adds the chip. Sending an empty list here would look like a new batch.
		this.deps.post({
			kind: "effects",
			effects: job.landed.effects,
			mine: job.mine,
			...this.mark(job.verdict, job.move),
		});
	}

	/**
	 * Issue the dedicated search for the half `job` is missing — full strength (`elo` omitted,
	 * which the UCI client turns into `UCI_LimitStrength false`) with the classifier's depth cap,
	 * or at `strengthElo` with no depth cap, the shape the session's own searches answer from the
	 * cache with. Once per half, and never twice for one position.
	 */
	private searchMissing(job: VerdictJob, strengthElo: number | undefined): void {
		if (job.closed || job.verdict || job.missing === null) return;
		const half = job.missing;
		if (job.searched[half]) return;
		const searcher = this.deps.searcher();
		if (!searcher) {
			this.setBlocker(job, "no-searcher", half);
			return;
		}
		job.searched[half] = true;
		const moves =
			half === "before" ? job.move.historyMoves : [...job.move.historyMoves, job.move.uci];
		const target = half === "before" ? boardKey(job.move.beforeFen) : job.afterKey;
		if (target === null || this.inFlight.has(target)) return;
		const req: AnalysisRequest = {
			id: newId(),
			fen: job.move.historyFen,
			...(moves.length > 0 ? { moves: [...moves] } : {}),
			multiPv: Q.multiPv,
			limit:
				strengthElo === undefined
					? { movetimeMs: Q.movetimeMs, depth: Q.depthCap }
					: { movetimeMs: Q.movetimeMs },
			...(strengthElo === undefined ? {} : { elo: strengthElo }),
			// The lowest rank the queue has: never delays a `move` or a `ponder` search.
			priority: "panel",
		};
		let handle: AnalysisHandle;
		try {
			handle = searcher.analyse(req);
		} catch (error) {
			log.debug("board effects: search refused", { error });
			this.setBlocker(job, "failed", half);
			return;
		}
		this.inFlight.set(target, handle);
		handle.result.then(
			(result) => {
				if (this.inFlight.get(target) === handle) this.inFlight.delete(target);
				if (this.disposed) return;
				if (result.status === "failed") {
					for (const waiting of this.waitingOn(target))
						this.setBlocker(waiting, "failed", waiting.missing ?? half);
					return;
				}
				this.supply(target, result.final.lines, req.elo === undefined);
				if (result.status !== "superseded") return;
				for (const waiting of this.waitingOn(target))
					if (waiting.blocker === "shallow" || waiting.blocker === "no-line")
						this.setBlocker(waiting, "superseded", waiting.missing ?? half);
			},
			(error: unknown) => {
				if (this.inFlight.get(target) === handle) this.inFlight.delete(target);
				log.debug("board effects: search failed", { error });
				for (const waiting of this.waitingOn(target))
					this.setBlocker(waiting, "failed", waiting.missing ?? half);
			}
		);
	}

	/** Open jobs whose missing half is the position `key`. */
	private waitingOn(key: string): VerdictJob[] {
		const jobs = this.prepared ? [...this.landed, this.prepared] : this.landed;
		return jobs.filter((job) => {
			if (job.closed || job.verdict || job.missing === null) return false;
			const want = job.missing === "before" ? boardKey(job.move.beforeFen) : job.afterKey;
			return want === key;
		});
	}
}
