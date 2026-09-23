/**
 * The scramble hold (`SCRAMBLE_HOLD`): during the opponent's turn, at a few human checkpoints,
 * the session may pick up the move it expects to play and carry the piece to its destination,
 * waiting for their move to let go — or give it back when their move makes it unsound. It also
 * owns the opponent turn's checkpoint cadence, which is where a queued premove gets its second
 * chance.
 */

import { matchingHistory } from "@core/chess/history";
import { phase as phaseOf } from "@core/chess/phase";
import { hangsOutright } from "@core/chess/safety";
import { applyMoves, legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { SCRAMBLE_HOLD } from "@core/constants/hold";
import type { AnalysisRequest, AnalysisUpdate } from "@core/engine/types";
import { log } from "@core/logger";
import { sampleRange } from "@core/motor/geometry";
import { createRng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import type { SelectionContext } from "@core/strength/types";
import { errorMessage } from "@core/util/errors";
import type { MoveContext } from "@service/move-executor";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, PositionSnapshot, Recommendation } from "@typedefs/game";
import { attachPredictedPolicy } from "../maia-session";
import { ownMoveMaiaElo } from "../recommendation";
import type { SessionCore } from "./core";
import { instantPlan, unsearchedRecommendation } from "./instant-plan";
import { boardKeyOf, TOP_LINE_RANK } from "./position-rules";
import type { Prediction } from "./prediction";
import type { PremoveArming } from "./premove";
import type { QueuedPremove } from "./queued-premove";

/** The move whose piece the hand is carrying, and the reply it was chosen against. */
interface HoldEntry {
	rec: Recommendation;
	reply: string;
}

export interface ScrambleHoldHooks {
	moveContext(rec: Recommendation): MoveContext;
}

export class ScrambleHold {
	/**
	 * The move whose piece the hand is carrying to its destination during the opponent's turn,
	 * waiting for their move to let go. `reply` is the reply it was chosen against; the position
	 * that arrives decides release or abandon.
	 */
	private entry: HoldEntry | null = null;
	/** The retry waiting for the ponder to offer a hold candidate. */
	private candidateTimer: unknown = null;
	/** The next hold-or-premove checkpoint of the opponent's turn (`scheduleDecision`). */
	private decisionTimer: unknown = null;

	constructor(
		private readonly core: SessionCore,
		private readonly arming: PremoveArming,
		private readonly queue: QueuedPremove,
		private readonly prediction: Prediction,
		private readonly hooks: ScrambleHoldHooks
	) {}

	/** Is the hand carrying a held piece right now? */
	holding(): boolean {
		return this.entry !== null;
	}

	/** Forget the held move (the cancel that abandons it has been, or is being, issued). */
	dropEntry(): void {
		this.entry = null;
	}

	/** Cancel the pending checkpoint and candidate retry. */
	clearTimers(): void {
		const scheduler = this.core.scheduler;
		if (this.candidateTimer !== null) {
			scheduler.clearTimeout(this.candidateTimer);
			this.candidateTimer = null;
		}
		if (this.decisionTimer !== null) {
			scheduler.clearTimeout(this.decisionTimer);
			this.decisionTimer = null;
		}
	}

	/**
	 * `SCRAMBLE_HOLD.decision*`: the next checkpoint of the opponent's turn at which the session may
	 * decide to hold a piece or enter a premove. Nothing is decided at the position itself — the
	 * hand is exploring, the ponder is running — and a checkpoint that decides nothing hands over
	 * to the next, until the opponent moves (`cancelInFlight` drops the timer) or they run out.
	 */
	scheduleDecision(snapshot: PositionSnapshot, tick: number, premoveTried: boolean): void {
		const core = this.core;
		this.decisionTimer = null;
		const C = SCRAMBLE_HOLD;
		if (tick >= C.decisionWeights.length) return;
		const delayMs = sampleRange(tick === 0 ? C.decisionFirstMs : C.decisionIntervalMs, core.rng);
		this.decisionTimer = core.scheduler.setTimeout(() => {
			this.decisionTimer = null;
			this.decide(snapshot, tick, premoveTried);
		}, delayMs);
	}

	private decide(snapshot: PositionSnapshot, tick: number, premoveTried: boolean): void {
		const core = this.core;
		if (core.disposed || core.snapshot !== snapshot || !core.mayAct()) return;
		if (this.queue.entry !== null || this.entry !== null) return;
		let tried = premoveTried;
		if (!tried && this.arming.armed !== null) {
			tried = true;
			this.queue.enter(snapshot);
			if (this.queue.entry !== null) return;
		}
		const weight = SCRAMBLE_HOLD.decisionWeights[tick] ?? 0;
		if (this.allowed(snapshot) && core.rng.chance(this.probability(snapshot) * weight)) {
			this.scheduleHold(snapshot, 0);
			return;
		}
		this.scheduleDecision(snapshot, tick + 1, tried);
	}

	/** The gates a hold needs whatever the odds: the switch, an armed hand, no premove outstanding. */
	private allowed(snapshot: PositionSnapshot): boolean {
		const core = this.core;
		return (
			core.mayAct() &&
			snapshot.myColor !== null &&
			core.executor?.isArmed() === true &&
			this.queue.entry === null &&
			this.entry === null
		);
	}

	/**
	 * `SCRAMBLE_HOLD`: a small chance in ordinary play, rising as our clock runs down towards the
	 * scramble — never certain, so the opponent cannot set a watch by it.
	 */
	private probability(snapshot: PositionSnapshot): number {
		const core = this.core;
		const C = SCRAMBLE_HOLD;
		const me = snapshot.myColor;
		if (me === null || !snapshot.timeControl) return C.regularProb;
		const ramp = (clockMs: number, startMs: number, endMs: number, top: number): number => {
			if (clockMs >= startMs) return C.regularProb;
			if (clockMs <= endMs) return top;
			return C.regularProb + ((startMs - clockMs) / (startMs - endMs)) * (top - C.regularProb);
		};
		const own = ramp(core.remainingClockMs(snapshot, me), C.rampStartMs, C.rampEndMs, C.scrambleProb);
		const theirs = ramp(
			core.remainingClockMs(snapshot, me === "w" ? "b" : "w"),
			C.opponentRampStartMs,
			C.opponentRampEndMs,
			C.opponentScrambleProb
		);
		return Math.max(own, theirs);
	}

	/** Either clock is inside its hold ramp: the scramble cap applies rather than the ordinary one. */
	private inScramble(snapshot: PositionSnapshot): boolean {
		const core = this.core;
		const me = snapshot.myColor;
		if (me === null || snapshot.timeControl === undefined) return false;
		return (
			core.remainingClockMs(snapshot, me) < SCRAMBLE_HOLD.rampStartMs ||
			core.remainingClockMs(snapshot, me === "w" ? "b" : "w") < SCRAMBLE_HOLD.opponentRampStartMs
		);
	}

	/**
	 * Pick the move to hold and hand it to the executor. The armed §7.4 premove is the best
	 * candidate when there is one; otherwise the ponder's top line — their reply and our answer to
	 * it — which may not be there for the first `SCRAMBLE_HOLD.candidateRetryMs`, hence the retry.
	 */
	private scheduleHold(snapshot: PositionSnapshot, attempt: number): void {
		const core = this.core;
		this.candidateTimer = null;
		const executor = core.executor;
		if (core.disposed || core.snapshot !== snapshot || !executor || !this.allowed(snapshot)) return;
		const candidate = this.candidate(snapshot);
		if (!candidate) {
			if (attempt >= SCRAMBLE_HOLD.candidateRetryMax) return;
			this.candidateTimer = core.scheduler.setTimeout(
				() => this.scheduleHold(snapshot, attempt + 1),
				SCRAMBLE_HOLD.candidateRetryMs
			);
			return;
		}
		const now = core.now();
		const race = core.racePolicyFor(snapshot);
		const delayMs =
			SCRAMBLE_HOLD.entryDelayMinMs +
			core.rng.next() * (SCRAMBLE_HOLD.entryDelayMaxMs - SCRAMBLE_HOLD.entryDelayMinMs);
		const windowMs = core.rng.next() * SCRAMBLE_HOLD.windowMaxMs;
		const plan = instantPlan({
			windowMs,
			deadlineMs: now + delayMs + windowMs,
			rationale: [...candidate.chosen.rationale, "scramble hold: released on the opponent's move"],
			clockRace: race?.urgency ?? 0,
		});
		const rec = unsearchedRecommendation(candidate.chosen, plan, now, candidate.fen);
		this.entry = { rec, reply: candidate.reply };
		executor.schedule(rec, plan, {
			...this.hooks.moveContext(rec),
			holdUntilReply: true,
			holdMaxMs: sampleRange(
				this.inScramble(snapshot) ? SCRAMBLE_HOLD.scrambleHoldMs : SCRAMBLE_HOLD.regularHoldMs,
				core.rng
			),
		});
		log.info("game-session: holding the piece over its square until the opponent moves", {
			tabId: core.tabId,
			uci: candidate.chosen.uci,
			reply: candidate.reply,
			inMs: Math.round(delayMs),
		});
	}

	/**
	 * The move to hold: the armed §7.4 premove (a recapture, an only move — a human's ready move
	 * anyway); else the ordinary selector run over the predicted position's analysis at
	 * the active target using the bounded predicted search; else — only sometimes — the ponder's
	 * own answer, which would be too strong to
	 * hold every time.
	 */
	private candidate(
		snapshot: PositionSnapshot
	): { reply: string; chosen: ChosenMove; fen: string } | null {
		const core = this.core;
		const armed = this.arming.armed;
		if (armed) return { reply: armed.reply, chosen: armed.chosen, fen: armed.fen };
		const analysed = this.prediction.validAnalysis(snapshot);
		if (analysed && analysed.lines.length > 0) {
			const chosen = this.readyMoveFrom(
				analysed.fen,
				analysed.lines,
				snapshot,
				analysed.request,
				analysed.bestmove,
				analysed.comparison
			);
			if (chosen) return { reply: analysed.reply, chosen, fen: analysed.fen };
		}
		if (!core.rng.chance(SCRAMBLE_HOLD.pvAnswerProb)) return null;
		const pv = core.ponderer?.latestLines(snapshot.fen)[0]?.pvUci;
		const reply = pv?.[0];
		const uci = pv?.[1];
		if (!reply || !uci) return null;
		const afterReply = applyMoves(snapshot.fen, [reply]);
		const parts = parseUci(uci);
		const san = afterReply === null ? null : uciToSan(afterReply, uci);
		if (afterReply === null || !parts || san === null) return null;
		const chosen: ChosenMove = {
			uci,
			san,
			...parts,
			source: "sampled",
			rankInLines: TOP_LINE_RANK,
			quality: { kind: "search", eligible: false, reason: "unknown", depth: 0, candidates: 0 },
			rationale: ["scramble hold: the ponder's answer to its predicted reply"],
		};
		return { reply, chosen, fen: afterReply };
	}

	/** Select a prepared reply with the active routing, history and search provenance. */
	readyMoveFrom(
		fen: string,
		lines: readonly EvalLine[],
		snapshot: PositionSnapshot,
		request: AnalysisRequest,
		bestmove: string | null,
		comparison?: AnalysisUpdate
	): ChosenMove | null {
		const core = this.core;
		const me = snapshot.myColor;
		if (me === null) return null;
		const settings = core.settings();
		const ctx: SelectionContext = {
			fen,
			targetElo: core.targetElo(),
			form: core.form.value,
			ply: snapshot.ply + 1,
			phase: phaseOf(fen) ?? "middlegame",
			myClockMs: core.remainingClockMs(snapshot, me),
			oppClockMs: core.remainingClockMs(snapshot, me === "w" ? "b" : "w"),
			selectionMode: settings.strength.selectionMode,
			blunderScale: settings.strength.blunderScale,
			history: matchingHistory({ fen: request.fen, moves: [...(request.moves ?? [])] }, fen) ?? {
				fen,
				moves: [],
			},
			engineResultKind: request.elo === undefined ? "unrestricted" : "native-limited",
			...(bestmove ? { engineBestmove: bestmove } : {}),
			...(comparison ? { shallowLines: comparison.lines, shallowDepth: comparison.depth } : {}),
			...(snapshot.timeControl
				? { baseMs: snapshot.timeControl.baseMs, incrementMs: snapshot.timeControl.incMs }
				: {}),
			rng: createRng(`${core.gameSeed}:hold:${boardKeyOf(fen)}`),
			// Its own streak/damper state: a ready move must not advance the game's real selection.
			state: createSelectionState(),
		};
		// H8: the pre-inferred answer for this very position makes the hold a Maia draw over the
		// pre-analysed lines (the selector runs its rails as usual); otherwise the §7.2 policy.
		const query = this.prediction.policyQueryFor(
			snapshot,
			fen,
			ctx.history ?? { fen, moves: [] },
			snapshot.ply + 1
		);
		const position = this.prediction.policyPosition(snapshot, fen, snapshot.ply + 1);
		if (position && query)
			ctx.contextEloPenalty = ownMoveMaiaElo(position, settings).contextEloPenalty;
		const maia = attachPredictedPolicy(ctx, this.prediction.policy, query?.identity);
		try {
			const chosen = selectMove(lines, ctx);
			chosen.rationale.push(
				maia
					? "ready move: a Maia draw over the pre-analysed lines"
					: "ready move: chosen for a hold at the active target"
			);
			return chosen;
		} catch (error) {
			log.debug("game-session: no ready move from the predicted analysis", {
				error: errorMessage(error),
			});
			return null;
		}
	}

	/**
	 * The opponent moved while the hand was holding a piece over its destination: let go if the held
	 * move is still legal and does not simply hang the piece, otherwise give it back. "Re-evaluate
	 * really badly" (the owner's words) is the hang check — a human in a scramble notices a piece
	 * left en prise and little else.
	 */
	settle(snapshot: PositionSnapshot, myTurn: boolean): Recommendation | null {
		const core = this.core;
		const executor = core.executor;
		const entry = this.entry;
		this.entry = null;
		if (!executor || !entry) return null;
		const holding = executor.holdingMove();
		if (!holding || holding.rec !== entry.rec) return null;
		const uci = entry.rec.chosen.uci;
		const last = snapshot.lastMove ?? null;
		const predicted = last !== null && `${last.from}${last.to}` === entry.reply.slice(0, 4);
		const legal =
			myTurn &&
			core.game?.gameId === snapshot.gameId &&
			legalMoves(snapshot.fen).includes(uci) &&
			!hangsOutright(snapshot.fen, uci);
		// Ordinary play: the ready move is often taken back for a searched one now that the reply
		// is known — more so when the reply was not the one it was prepared against. A scramble
		// has no time for second thoughts beyond the hang check.
		const kept =
			legal &&
			(this.inScramble(snapshot) ||
				core.rng.chance(
					predicted ? SCRAMBLE_HOLD.regularKeepPredicted : SCRAMBLE_HOLD.regularKeepUnexpected
				));
		log.info(
			kept
				? "game-session: the opponent moved; releasing the held piece"
				: legal
					? "game-session: taking the held move back for a searched one"
					: "game-session: the held move is unsound now; giving the piece back",
			{
				tabId: core.tabId,
				uci,
				reply: entry.reply,
				predicted,
				lastMove: last?.san ?? null,
				// H8: a Maia-drawn hold was drawn for the *predicted* position; an unexpected reply
				// means the model's answer was for another board, and the legality + hang check above
				// is exactly the stale-hold check that covers it (no second path).
				maia: entry.rec.chosen.source === "maia",
			}
		);
		if (!kept) {
			executor.abandonHold();
			return null;
		}
		// The move is played in *this* position, and the report is recognised by identity.
		entry.rec.fen = snapshot.fen;
		executor.releaseHold();
		return entry.rec;
	}
}
