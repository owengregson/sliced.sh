/**
 * Fix F: a premove **entered on the site** during the opponent's turn — the way the site's own
 * premove works — and settled by the position that follows. It is not a played move and is never
 * accounted as one until that position proves it.
 */

import { applyMoves, legalMoves, uciToSan } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { log } from "@core/logger";
import { isQueueableCandidate } from "@core/strength/premove";
import type { ExecutionReport, MoveContext } from "@service/move-executor";
import type { ChosenMove, ExecutionResult, PositionSnapshot, Recommendation } from "@typedefs/game";
import type { MoveTelemetryRecord } from "@typedefs/telemetry";
import type { TimingPlan } from "@typedefs/timing";
import { PremoveAttemptLimit } from "../premove-attempts";
import { type MoveWindow, selectedMultiplePieces } from "../telemetry";
import type { SessionCore } from "./core";
import { instantPlan, unsearchedRecommendation } from "./instant-plan";
import type { MoveRecorder } from "./move-recorder";
import { boardKeyOf, PREMOVE_WINDOW_MS } from "./position-rules";
import type { PremoveArming } from "./premove";

/**
 * Fix F: a premove **entered on the site** during the opponent's turn, waiting for their move to
 * resolve it. It is not a played move and is never accounted as one until the next position proves
 * it: `reconcile` compares that position with `fromFen + reply + uci` and only then writes the §8.6
 * row, the §13.2 record and the §13.6 fold.
 */
export interface PremoveEntry {
	/** The reply the premove is conditioned on. */
	reply: string;
	chosen: ChosenMove;
	/** The position the drag was dispatched in — the opponent is to move in it. */
	fromFen: string;
	/** Ply of the position the premove belongs to: the one after `reply`. */
	ply: number;
	/** Our clock in `fromFen` (the §8.6 row's `clockMs`). */
	clockMs: number;
	plan: TimingPlan;
	/** The recommendation handed to the executor; its identity is how its report is recognised. */
	rec: Recommendation;
	/** The drag's own result, once it finished; `null` while it is still pending or running. */
	result: ExecutionResult | null;
	/**
	 * The §13.2 window the drag happens in — a *fork* of the opponent-turn window, never the
	 * session's own. `onPosition` opens a fresh window for every position, and a premove report can
	 * arrive after that has happened (the deferred settle below), so a premove that closed the
	 * session's window would both mis-describe itself and steal the next move's record.
	 */
	window: MoveWindow;
	/** The §13.2 record of that window (built when the drag finished). */
	record: MoveTelemetryRecord | null;
	/** Set when a cancel path gave the premove up while it was already out of our hands. */
	abandoned: string | null;
	/**
	 * The position waiting to settle this premove because the drag had not reported yet when it
	 * arrived. At bullet the opponent can easily reply inside the drag's own wind-down, so the
	 * report and the position race; whichever is second does the reconciliation.
	 */
	settleWith: PositionSnapshot | null;
}

export interface QueuedPremoveHooks {
	moveContext(rec: Recommendation): MoveContext;
	/** The hand is free again during the opponent's turn: let it explore. */
	startOpponentExploration(): void;
}

export class QueuedPremove {
	/** The premove this session has entered on the site, until the next position settles it. */
	entry: PremoveEntry | null = null;
	private readonly attempts = new PremoveAttemptLimit();
	/**
	 * Whether the *site* keeps the premoves we send. chess.com's own premove setting is not
	 * readable, so this is learned from the one observation that answers it: a **completed** gesture,
	 * the predicted reply, and our move not on the board. `null` = not known yet (try), `false` =
	 * fall back to §7.4's fast reply, `true` = a premove of ours has fired.
	 *
	 * Deliberately **per tab, not per game**: every attempt on a board that refuses them costs a
	 * visible snap-back and a real press outside any move window, so the lesson is worth keeping for
	 * as long as the page is. A reload re-tests it, which is also what a player who changed the
	 * setting would do.
	 */
	private queueing: boolean | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly arming: PremoveArming,
		private readonly recorder: MoveRecorder,
		private readonly hooks: QueuedPremoveHooks
	) {}

	/** A new game. `queueing` is *not* reset: it is a fact about the page, not about the game. */
	resetForGame(): void {
		this.entry = null;
		this.attempts.reset();
	}

	/** Is `rec` the recommendation of the premove entered on the site? */
	isEntry(rec: Recommendation): boolean {
		return this.entry !== null && rec === this.entry.rec;
	}

	/** A premove of ours was played through the ordinary path: its attempt budget starts over. */
	notePlayed(): void {
		this.attempts.reset();
	}

	/**
	 * Enter the armed premove on the site, during the opponent's turn, the way the site's own
	 * premove works: you make the move while it is their turn and the site fires it the instant
	 * they move. Everything about it is deliberately narrow.
	 *
	 *   - **Only a self-invalidating reason** (`isQueueableReason`). A queued move fires whether or
	 *     not the prediction held, so the gate cannot be "the prediction is likely" — it has to be
	 *     "an unexpected reply makes this illegal", which a recapture and the only legal move are
	 *     and a clear-best quiet move is not.
	 *   - **Only once per opponent turn**, and never while one is already outstanding.
	 *   - **Only while the site is still holding them** (`queueing`).
	 *   - **The human moment**, not the instant the position appeared and not the end of their
	 *     think: `U(PREMOVE.queueDelayMinMs, queueDelayMaxMs)` after it, with the drag itself given
	 *     the §7.4 window. A think shorter than the delay simply never reaches the drag, and the
	 *     arm is still there for the fast reply instead.
	 *
	 * The §3.2 recommendation is *not* published for it: the live position is the opponent's, and a
	 * premove is not a recommendation for it. Nothing is logged as planned or played here either —
	 * the next position is what decides that (`reconcile`).
	 */
	enter(snapshot: PositionSnapshot): void {
		const core = this.core;
		const armed = this.arming.armed;
		const executor = core.executor;
		if (!armed || !executor || core.disposed) return;
		if (this.entry !== null) return;
		if (!this.attempts.canQueue(armed.chosen.uci)) {
			log.debug("game-session: repeated avoided premove held for a legal reactive reply", {
				tabId: core.tabId,
				uci: armed.chosen.uci,
			});
			return;
		}
		if (
			this.queueing === false ||
			!isQueueableCandidate(snapshot.fen, {
				reply: armed.reply,
				premove: armed.chosen.uci,
				reason: armed.reason,
			})
		)
			return;
		if (!core.mayAct() || !executor.isArmed()) return;
		const myColor = snapshot.myColor;
		if (myColor === null || snapshot.sideToMove === myColor) return;
		if (core.snapshot !== snapshot) return;
		// The SAN only exists in the position the premove is played in — it is not a legal move in
		// the one we are entering it from, which is the whole point of a premove.
		const afterReply = applyMoves(snapshot.fen, [armed.reply]);
		const san = afterReply === null ? null : uciToSan(afterReply, armed.chosen.uci);
		if (afterReply === null || san === null) {
			log.debug("game-session: premove not enterable (the predicted position does not hold it)", {
				tabId: core.tabId,
				reply: armed.reply,
				uci: armed.chosen.uci,
			});
			return;
		}
		const chosen: ChosenMove = { ...armed.chosen, san };
		const now = core.now();
		const race = core.racePolicyFor(snapshot);
		const [delayMin, delayMax] = race
			? [PREMOVE.fastQueueDelayMinMs, PREMOVE.fastQueueDelayMaxMs]
			: armed.reason === "recapture"
				? [PREMOVE.tradeQueueDelayMinMs, PREMOVE.tradeQueueDelayMaxMs]
				: [PREMOVE.queueDelayMinMs, PREMOVE.queueDelayMaxMs];
		const delayMs = delayMin + core.rng.next() * (delayMax - delayMin);
		const windowMs =
			core.rng.next() * Math.min(PREMOVE_WINDOW_MS, race?.maxMoveMs ?? PREMOVE_WINDOW_MS);
		const plan = instantPlan({
			windowMs,
			deadlineMs: now + delayMs + windowMs,
			rationale: [...chosen.rationale],
			clockRace: race?.urgency ?? 0,
		});
		// The position it will be played in, which is what seeds the hand and what the §8.6 row
		// belongs to — not the one it is entered from.
		const rec = unsearchedRecommendation(chosen, plan, now, afterReply);
		this.entry = {
			reply: armed.reply,
			chosen,
			fromFen: snapshot.fen,
			ply: snapshot.ply + 1,
			clockMs: snapshot.clocks[myColor].ms,
			plan,
			rec,
			// The fork is the window the drag happens in; `now` is what it opens at if the session's
			// own window has already been closed by a late report for the previous move.
			window: core.window.fork(now),
			result: null,
			record: null,
			abandoned: null,
			settleWith: null,
		};
		executor.schedule(rec, plan, this.hooks.moveContext(rec));
		log.info("game-session: entering a premove on the site during the opponent's turn", {
			tabId: core.tabId,
			uci: chosen.uci,
			reply: armed.reply,
			reason: armed.reason,
			inMs: Math.round(delayMs),
		});
	}

	/**
	 * A terminal executor report that belongs to the premove drag rather than to a move of our own
	 * (`true` when it was handled here). A `dispatched` report means the gesture went out and
	 * nothing was played — acceptance by the site is unknown — so none of `onExecuted`'s accounting
	 * may run; the §13.2 record of the window the drag happened in (a fork of the *opponent's*
	 * window, which is where the input really was) is built now and attached only if the next
	 * position shows the move.
	 *
	 * An outcome that is not `dispatched` is a drag the hand did not finish. The entry is kept when a
	 * press had already gone out, because the page may have seen a press on one square and a
	 * release on another and be holding something; it is forgotten when nothing was pressed.
	 */
	settleDrag(report: ExecutionReport): boolean {
		const core = this.core;
		const entry = this.entry;
		if (!entry || report.rec !== entry.rec) return false;
		const result = report.result;
		const pressed = result.pressed === true || result.pressedAny === true;
		if (result.outcome === "dispatched" || pressed) {
			entry.result = result;
			// `??=`, not `=`: one terminal report per execution is the rule, but closing the fork a
			// second time would replace a good record with `null` (a closed window produces none), so
			// the footgun is removed rather than relied on.
			entry.record ??= entry.window.close({
				elapsedMs: result.elapsedMs,
				pointerOffsetPx: result.pointerOffsetPx ?? 0,
				multiplePieces: selectedMultiplePieces(result, entry.chosen.from),
				orientationMs: entry.plan.orientationMs,
				// §13.2: a premove is never "non-trivial" — a premove press is a committed move
				// attempt, not a §9.3a preview touch, so it must never enter the preview-rate band
				// (`report.py` takes that denominator from this very field).
				multiSelectEligible: false,
				nReasonable: 1,
				// §13.6: a premove is decided before its position exists and carries no evaluation.
				quality: undefined,
				// The window is the opponent's turn, a period the owner owns: a focus edge in it is his
				// behaviour, and the §13.2 conduct rules are told so explicitly rather than inferring
				// it from the mode.
				ownerOwnsWindow: true,
				at: result.at ?? core.now(),
			});
		}
		if (result.outcome === "dispatched") {
			// Deliberately not "the site is holding our premove": all that is known here is that the
			// drag went out. chess.com exposes no premove state the extension can read, so acceptance
			// is unconfirmed until the next position either contains the move or does not.
			log.info("game-session: premove dispatched, acceptance unconfirmed", {
				tabId: core.tabId,
				uci: entry.chosen.uci,
				ply: entry.ply,
				abandoned: entry.abandoned,
			});
		} else if (pressed) {
			log.warn("game-session: the premove drag was interrupted after a press; the site may have it", {
				tabId: core.tabId,
				uci: entry.chosen.uci,
				outcome: result.outcome,
				reason: result.reason ?? null,
			});
		} else {
			this.entry = null;
			log.info("game-session: no premove was entered", {
				tabId: core.tabId,
				uci: entry.chosen.uci,
				outcome: result.outcome,
				reason: result.reason ?? null,
			});
		}
		// The position that was waiting for this report (the race above) settles the premove now.
		const waiting = entry.settleWith;
		if (waiting !== null && this.entry === entry) this.reconcile(waiting);
		this.hooks.startOpponentExploration();
		core.notify();
		return true;
	}

	/**
	 * Settle the premove against the position that has just arrived — the only signal there is.
	 * Nothing observable says whether the site *accepted* the gesture; what proves it was **played**
	 * is the position itself containing the move, read from `board.game`'s own FEN (or the move
	 * list's replay), never from a marking or an animation. Three outcomes, and the fourth
	 * that tells us the site is not holding them at all:
	 *
	 *   1. the predicted reply, our premove on the board — the happy path;
	 *   2. another reply, our premove gone — the site dropped it as illegal: a normal turn, planned
	 *      normally by the caller;
	 *   3. another reply, our premove on the board anyway — it is still our move and is recorded as
	 *      one, even though no search ever chose it for that position (§13.6 scores it as a premove,
	 *      i.e. not at all, and `buildTimingLogEntry` writes its `mode: "premove"` row);
	 *   4. the predicted reply, our premove gone — the prediction was right and the site played
	 *      nothing, so it is not holding our premoves: fall back to §7.4's fast reply from here on.
	 */
	reconcile(snapshot: PositionSnapshot): void {
		const core = this.core;
		const entry = this.entry;
		if (!entry) return;
		if (entry.result === null && this.dragInFlight(entry)) {
			// The drag is still winding down. Settling now would report "never entered" for a premove
			// the site may already be holding, so the drag's own report finishes this instead.
			entry.settleWith = snapshot;
			log.debug("game-session: the premove drag has not reported yet; settling on its report", {
				tabId: core.tabId,
				uci: entry.chosen.uci,
			});
			return;
		}
		this.entry = null;
		const result = entry.result;
		if (result === null) {
			log.info("game-session: the premove was never entered", {
				tabId: core.tabId,
				uci: entry.chosen.uci,
				reason: entry.abandoned ?? "the opponent moved first",
			});
			return;
		}
		const played = landedAfter(entry, snapshot);
		if (played !== null) {
			this.attempts.reset();
			this.queueing = true;
			this.arming.drop();
			core.history.noteTwoPlies(entry.fromFen, played, entry.chosen.uci, snapshot);
			this.recorder.recordQueuedPremove(entry, result);
			if (played === entry.reply)
				log.info("game-session: the premove fired — the opponent played the predicted reply", {
					tabId: core.tabId,
					uci: entry.chosen.uci,
					reply: played,
					ply: entry.ply,
					abandoned: entry.abandoned,
				});
			else
				log.warn("game-session: the premove fired after an unexpected reply — recorded as ours", {
					tabId: core.tabId,
					uci: entry.chosen.uci,
					expected: entry.reply,
					played,
					ply: entry.ply,
				});
			return;
		}
		// The page saw the press even though the site kept nothing: §13.2 charges it to the *next*
		// move's window, so the next move's record has to carry it (`MoveRecorder`).
		if (result.pressed === true || result.pressedAny === true)
			this.recorder.notePressedPremove(entry.chosen.from);
		const afterReply = applyMoves(entry.fromFen, [entry.reply]);
		const predicted = afterReply !== null && boardKeyOf(afterReply) === boardKeyOf(snapshot.fen);
		// Do not infer an ignored attempt from a corrected reading, a skipped position, or an
		// opponent move that interrupted the gesture. A late acknowledgement is conservatively
		// ignored too: only a completed report already present when the reply arrived counts.
		const completedBeforeReply =
			result.outcome === "dispatched" &&
			entry.settleWith === null &&
			(result.at === undefined || result.at <= snapshot.capturedAt);
		const observedReply =
			snapshot.ply === entry.ply &&
			(predicted ||
				legalMoves(entry.fromFen).some((reply) => {
					const after = applyMoves(entry.fromFen, [reply]);
					return after !== null && boardKeyOf(after) === boardKeyOf(snapshot.fen);
				}));
		if (observedReply)
			this.attempts.observe(entry.chosen.uci, {
				completedBeforeReply,
				predicted,
				landed: false,
			});
		if (predicted) {
			// Only a *completed* gesture is evidence about the site. A drag the arriving position
			// aborted mid-flight still carries `pressed`, and treating that as "the site does not
			// hold premoves" switched the feature off for the rest of the game on the commonest
			// path at bullet — one attempt per game, blamed on chess.com (found in review).
			if (result.outcome === "dispatched") {
				this.queueing = false;
				log.warn(
					"game-session: the predicted reply arrived and the premove was not played — the site is not holding our premoves; the fast reply takes over",
					{ tabId: core.tabId, uci: entry.chosen.uci, reply: entry.reply }
				);
				return;
			}
			log.info("game-session: the premove drag never finished; nothing was learned about the site", {
				tabId: core.tabId,
				uci: entry.chosen.uci,
				outcome: result.outcome,
				reason: result.reason ?? null,
			});
			return;
		}
		// "Dropped" is what the site does with an illegal premove, but we cannot see whether it ever
		// held this one, so the line says only what the board shows.
		log.info("game-session: the premove is not on the board after an unexpected reply", {
			tabId: core.tabId,
			uci: entry.chosen.uci,
			expected: entry.reply,
			dispatched: result.outcome === "dispatched",
		});
	}

	/**
	 * Is the premove's drag still going to report? `cancel()` (which every path that reaches here
	 * has already run) clears a drag that was merely *scheduled* and nothing more will be heard of
	 * it, but a drag already running winds down through the hand's release and reports afterwards.
	 */
	private dragInFlight(entry: PremoveEntry): boolean {
		const executor = this.core.executor;
		if (!executor) return false;
		return executor.isRunning() || executor.pendingMove()?.rec === entry.rec;
	}

	/**
	 * Give up the premove: `Shift+X`, the master switch, a disarm, a game end, a tab navigation, a
	 * disposed session. Every one of those paths cancels the hand first, so a premove still waiting
	 * for its moment is simply never entered — which is the only cancellation that is wholly ours.
	 *
	 * One already entered is the **site's** state, and we cannot take it back: retracting a premove
	 * on chess.com is another press on the board, and §13.7 item 3 allows the hand only the presses
	 * the §9.3a model generates (and the gesture itself is one we have never verified on a real
	 * board — dispatching the wrong one could leave a piece selected, which that rule forbids
	 * outright). So the entry is *kept*, not dropped: it is never reported as played unless the
	 * board shows it, and if the site does fire it the move was still ours and is accounted as ours.
	 * What bounds the exposure is the policy, not us: a queued premove is a recapture or the only
	 * legal move, so an opponent who plays anything else makes it illegal and the site drops it.
	 */
	abandon(reason: string): void {
		const entry = this.entry;
		if (entry === null || entry.abandoned !== null) return;
		entry.abandoned = reason;
		if (entry.result === null) {
			log.info("game-session: a premove was given up before it was entered", {
				tabId: this.core.tabId,
				reason,
				uci: entry.chosen.uci,
			});
			return;
		}
		log.warn(
			"game-session: a premove had already been entered on the site and cannot be taken back",
			{ tabId: this.core.tabId, reason, uci: entry.chosen.uci, reply: entry.reply }
		);
	}
}

/**
 * The opponent reply after which our premove is on `snapshot`'s board, or `null` when it is not
 * there. Placement plus side to move is the comparison (`boardKeyOf`), so a reading the adapter
 * had to approximate still answers, and the predicted reply is tried first because it is both
 * the common case and the cheap one.
 */
function landedAfter(entry: PremoveEntry, snapshot: PositionSnapshot): string | null {
	const want = boardKeyOf(snapshot.fen);
	const others = legalMoves(entry.fromFen).filter((m) => m !== entry.reply);
	for (const reply of [entry.reply, ...others]) {
		const after = applyMoves(entry.fromFen, [reply]);
		if (after === null) continue;
		const both = applyMoves(after, [entry.chosen.uci]);
		if (both !== null && boardKeyOf(both) === want) return reply;
	}
	return null;
}
