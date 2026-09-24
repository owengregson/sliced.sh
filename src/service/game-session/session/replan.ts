/**
 * The timing model's view of the move the session is on, and the one re-plan built from it that
 * more than one path needs (`repaced`: a withheld recommendation released late).
 */

import { EXECUTOR } from "@core/constants/cdp";
import type { TimingContext } from "@core/timing/types";
import type { Recommendation } from "@typedefs/game";
import type { SessionCore } from "./core";
import { timeControlSeconds } from "./position-rules";

/**
 * The timing model's view of the current move, or `null` when there is no position to build it
 * from — including the one that matters: a position whose colour is not known. There is no
 * default side here. Defaulting to white is what made the model plan, and the hand play, for
 * the opponent (owner's live test, 2026-09-09); a caller that cannot build a context does not
 * replan, which leaves the standing plan exactly as it was.
 */
export function timingContextFor(core: SessionCore, rec: Recommendation): TimingContext | null {
	const snapshot = core.snapshot;
	const settings = core.settings();
	const myColor = snapshot?.myColor ?? null;
	if (myColor === null) return null;
	const [baseSec, incSec] = core.game ? timeControlSeconds(core.game) : [0, 0];
	const history = core.history;
	return {
		fen: rec.fen,
		ply: snapshot?.ply ?? 0,
		moves: [...history.moves],
		myColor,
		chosenMove: rec.chosen.uci,
		lines: rec.lines,
		evalBeforeOppMove: core.timing?.state.lastEvalOurPov ?? null,
		expectedOppReply: core.ponderer?.expectedReply() ?? null,
		myClockMs: snapshot ? snapshot.clocks[myColor].ms : 0,
		oppClockMs: snapshot ? snapshot.clocks[myColor === "w" ? "b" : "w"].ms : 0,
		baseSec,
		incSec,
		oppThinkMsHistory: [...history.oppThinkMs],
		myThinkMsHistory: [...history.myThinkMs],
		site: core.site ?? "chesscom",
		targetElo: core.targetElo(),
		profile: settings.strength.persona,
		engineReady: core.deps.engine !== null,
		inputMethod: EXECUTOR.committedTier,
		autoQueen: true,
		nowMs: core.now(),
		priorFen: history.priorFen,
	};
}

/**
 * The withheld recommendation with its plan re-planned for the wait (see
 * `GameSession.reconsider`). The recommendation itself is unchanged — the move the panel is
 * showing is the move that gets played — and the session adopts the result so the panel's plan
 * line and §8.6's row agree with what the hand was actually given. Unchanged when there is no
 * timing model or no usable context.
 */
export function repaced(core: SessionCore, rec: Recommendation): Recommendation {
	const timing = core.timing;
	const ctx = timing ? timingContextFor(core, rec) : null;
	if (!timing || !ctx) return rec;
	// `withheld-then-released` folds `now - <the position's arrival>` into the think and applies no clock
	// cap of its own (unlike `clock-jump`), so a long enough wait would record a `plannedMs` longer
	// than the clock the move started with — a malformed §8.6 row, and the same number
	// `report.py`'s think-time bands read. The clock in the snapshot is frozen at the moment the
	// position was read, so it *is* the bound; clamp the elapsed time the model is told about
	// rather than the plan it returns, and every window the plan carries stays consistent.
	//
	// `affordable` is deliberately not floored at 0. A clock shorter than the approach makes it
	// negative, which tells the model the move started *after* now — and that cannot change the
	// answer, because `withheld-then-released` returns `max(plan.thinkMs, spent + approach)` and
	// `approachMs <= thinkMs` by construction, so the `plan.thinkMs` term wins for any negative
	// `spent`. Measured identical (think and window sum, to the millisecond) with and without a
	// floor at clocks of 200 ms and 50 ms against a 20 s wait. A floor here would be a line no
	// mutation could kill.
	// An untimed game has no clock to exceed, so nothing is clamped and the whole wait folds in.
	const startedAt = rec.plan.deadlineMs - rec.plan.thinkMs;
	const affordable = ctx.myClockMs - rec.plan.window.approachMs;
	// Epoch timestamps lose sub-millisecond precision; round the ceiling down so
	// adding the sampled approach cannot put the result just above the clock.
	const nowMs =
		ctx.myClockMs > 0 ? Math.min(ctx.nowMs, Math.floor(startedAt + affordable)) : ctx.nowMs;
	return { ...rec, plan: timing.replan(rec.plan, { ...ctx, nowMs }, "withheld-then-released") };
}
