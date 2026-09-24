/**
 * §7.4's premove *decision*: during the opponent's turn, pre-compute the move we would answer
 * their expected reply with (`arm`), let the pre-inferred Maia answer veto it (H8, `gateWithPolicy`),
 * and — when that reply lands and the site was not holding the premove — play it at once without a
 * fresh search (`fireOnReply`). Entering it on the site during their turn is `QueuedPremove`'s.
 */

import { uciToSan } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import { requestEloForTarget } from "@core/engine/options";
import type { AnalysisRequest } from "@core/engine/types";
import { log } from "@core/logger";
import type { PolicyResult } from "@core/policy/types";
import type { PremoveReason } from "@core/strength/premove";
import { maiaPremoveGate, premoveCandidate } from "@core/strength/premove";
import { calibrationTimeClass, premovePropensity } from "@core/timing/calibration";
import { errorMessage } from "@core/util/errors";
import type { MoveContext } from "@service/move-executor";
import type { ChosenMove, PositionSnapshot, Recommendation } from "@typedefs/game";
import type { SessionCore } from "./core";
import { instantPlan, unsearchedRecommendation } from "./instant-plan";
import type { MoveRecorder } from "./move-recorder";
import { MS_PER_S, PREMOVE_WINDOW_MS } from "./position-rules";
import type { Prediction } from "./prediction";

export interface PremoveArm {
	/** The opponent reply the premove is conditioned on. */
	reply: string;
	chosen: ChosenMove;
	/** Position the premove is played from (after our move and the expected reply). */
	fen: string;
	/** Why the policy accepted it — `PREMOVE.queueReasons` decides which may be *queued* (Fix F). */
	reason: PremoveReason;
}

export interface PremoveArmingHooks {
	/** Is a premove already entered on the site (Fix F)? That one is the site's and is left alone. */
	entered(): boolean;
	moveContext(rec: Recommendation): MoveContext;
}

export class PremoveArming {
	armed: PremoveArm | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly prediction: Prediction,
		private readonly recorder: MoveRecorder,
		private readonly hooks: PremoveArmingHooks
	) {}

	/** Give up the arm (an unarmed hand must not fire a premove on the next position either). */
	drop(): void {
		this.armed = null;
	}

	/** After our move: pre-compute the premove for the opponent's expected reply. */
	async arm(snapshot: PositionSnapshot): Promise<void> {
		const core = this.core;
		this.armed = null;
		const engine = core.deps.engine;
		const timing = core.timing;
		const moves = core.history.moves;
		const last = moves[moves.length - 1];
		// §4.4: `premoveCandidate` issues its own `analyse` at `ponder` priority, so the switch is
		// checked here too (unknown holds, like everywhere else).
		if (!core.mayAct()) return;
		if (!engine || !timing || last === undefined) return;
		const previous = core.history.priorFen;
		if (previous === null) return;
		const targetElo = core.targetElo();
		const generation = core.workGeneration;
		const candidatePolicy = this.prediction.policy;
		const predictedReply = this.prediction.analysis?.reply;
		const rootHistory = core.historyFor(snapshot.fen);
		const policyQuery =
			candidatePolicy && predictedReply
				? this.prediction.policyQueryFor(
						snapshot,
						candidatePolicy.fen,
						{ fen: rootHistory.fen, moves: [...rootHistory.moves, predictedReply] },
						snapshot.ply + 1
					)
				: null;
		const piP = 1 / (1 + Math.exp(-(timing.persona.pi_p + timing.state.knobs.piOffset)));
		const heldPolicy =
			candidatePolicy && policyQuery?.identity === candidatePolicy.identity ? candidatePolicy : null;
		try {
			const candidate = await premoveCandidate(
				{
					fen: previous,
					move: last,
					historyAfterMove: core.historyFor(snapshot.fen),
					targetElo: core.targetElo(),
					timeControl: snapshot.timeControl,
					ownClockMs: snapshot.myColor ? core.remainingClockMs(snapshot, snapshot.myColor) : 0,
					opponentClockMs: snapshot.myColor
						? core.remainingClockMs(snapshot, snapshot.myColor === "w" ? "b" : "w")
						: 0,
					ponder: core.ponderer?.expectedReply(snapshot.fen) ?? undefined,
					// H8: an answer already in hand gates the candidate in its position; the usual case
					// (the answer arriving after the arm) is `gateWithPolicy`.
					...(heldPolicy ? { policy: { fen: heldPolicy.fen, result: heldPolicy.result } } : {}),
					rng: core.rng,
					// `Persona.pi_p` is in logit units; the policy takes a probability in [0, 1].
					piP,
					propensity: premovePropensity(
						calibrationTimeClass(
							(snapshot.timeControl?.baseMs ?? 0) / MS_PER_S,
							(snapshot.timeControl?.incMs ?? 0) / MS_PER_S
						),
						targetElo,
						piP
					),
				},
				{
					analyseAfter: async (_fen, moves, opts) => {
						const root = core.historyFor(snapshot.fen);
						const request: AnalysisRequest = {
							id: `${core.tabId}-premove-${core.now()}`,
							targetElo,
							fen: root.fen,
							moves: [...root.moves, ...moves.slice(1)],
							multiPv: opts.multiPv,
							limit: { movetimeMs: opts.movetimeMs, depth: automaticDepthForElo(core.targetElo()) },
							priority: "ponder",
						};
						// The same strength as every other search this session issues (the ponder sets
						// it too). Without it these results are keyed at a different strength from the
						// own-move search that would reuse them, so they could never be a cache hit.
						const elo = requestEloForTarget(core.targetElo());
						if (elo !== undefined) request.elo = elo;
						const handle = engine.analyse(request);
						const result = await handle.result;
						return result.final.lines;
					},
				}
			);
			// The search above is an await: a flip-off inside it already nulled `armed`, so a
			// candidate must not be published over the top of that (§4.4).
			if (
				!candidate ||
				core.disposed ||
				core.snapshot !== snapshot ||
				!core.mayAct() ||
				generation !== core.workGeneration
			)
				return;
			const chosen: ChosenMove = {
				uci: candidate.premove,
				san: candidate.premove,
				from: candidate.from,
				to: candidate.to,
				source: "premove",
				rankInLines: 0,
				cpLoss: 0,
				rationale: [`premove: ${candidate.reason} (p(reply)=${candidate.replyProbability.toFixed(2)})`],
			};
			if (candidate.promotion) chosen.promotion = candidate.promotion;
			this.armed = {
				reply: candidate.reply,
				chosen,
				fen: snapshot.fen,
				reason: candidate.reason,
			};
			log.info("game-session: premove armed", {
				tabId: core.tabId,
				reply: candidate.reply,
				premove: candidate.premove,
				reason: candidate.reason,
			});
		} catch (error) {
			log.debug("game-session: premove unavailable", { error: errorMessage(error) });
		}
	}

	/**
	 * H8: the premove gate, applied after the fact. `arm` runs before the pre-inference (its own
	 * reply search is what the prediction comes from), so the answer usually lands with a premove
	 * already armed; if the model gives that move under `PREMOVE.maiaMinProb` in the predicted
	 * position, the arm is dropped — the hold and the fast reply then fall through to the ordinary
	 * paths. A premove already *entered* on the site is the site's (Fix F) and is left.
	 */
	gateWithPolicy(reply: string, predicted: string, result: PolicyResult): void {
		const armed = this.armed;
		if (!armed || armed.reply !== reply || this.hooks.entered()) return;
		const policy = { fen: predicted, result };
		if (maiaPremoveGate(predicted, armed.chosen.uci, policy)) return;
		this.armed = null;
		log.info("game-session: premove dropped — the human model would not play it here", {
			tabId: this.core.tabId,
			uci: armed.chosen.uci,
			reply,
			reason: armed.reason,
			minProb: PREMOVE.maiaMinProb,
		});
	}

	/**
	 * The **fallback** path (Fix F): the opponent played the reply the premove was conditioned on
	 * and the premove is not already on the board, so the site was holding nothing — premoves are
	 * off in the player's own chess.com settings, the queue was never entered (their think was
	 * shorter than the entry delay), or `QueuedPremove.reconcile` has just learned the site drops
	 * them. Play it at once instead (`t_premove ~ U(0, PREMOVE.maxS)`, §7.4) without a fresh search.
	 *
	 * This is reached only on *our* turn, which a fired premove never produces (the site plays it
	 * in the same position the reply arrives in, so the next position we see is the opponent's
	 * again). The two paths therefore cannot both play: the queued premove and this one are the
	 * same move, and the executor's own position guard vetoes the second of them.
	 */
	async fireOnReply(snapshot: PositionSnapshot): Promise<boolean> {
		const core = this.core;
		const armed = this.armed;
		this.armed = null;
		const executor = core.executor;
		const timing = core.timing;
		if (!armed || !executor || !timing || !executor.isArmed()) return false;
		const moves = core.history.moves;
		const last = moves[moves.length - 1];
		if (last !== armed.reply) return false;
		const san = uciToSan(snapshot.fen, armed.chosen.uci);
		if (san === null) return false;
		const chosen: ChosenMove = { ...armed.chosen, san };
		const race = core.racePolicyFor(snapshot);
		const fireInMs =
			core.rng.next() * Math.min(PREMOVE_WINDOW_MS, race?.maxMoveMs ?? PREMOVE_WINDOW_MS);
		const now = Math.min(core.positionArrivedAt ?? snapshot.capturedAt, core.now());
		const plan = instantPlan({
			windowMs: fireInMs,
			deadlineMs: now + fireInMs,
			rationale: [...chosen.rationale],
			clockRace: race?.urgency ?? 0,
		});
		const rec = unsearchedRecommendation(chosen, plan, now, snapshot.fen);
		core.rec = rec;
		this.recorder.notePosition(rec.chosen, snapshot.gameId, snapshot.ply);
		core.recNReasonable = 1;
		// §8.6 wants a row per *played* move, and a premove never goes through `planMove` (it was
		// decided during the opponent's turn), so the session writes its row itself — otherwise
		// `markActual` / `attachTelemetry` would have nothing to attach to and the move would be
		// missing from the export entirely.
		this.recorder.appendPremoveRow(
			core.game?.gameId ?? "",
			snapshot.ply,
			fireInMs,
			snapshot.myColor ? snapshot.clocks[snapshot.myColor].ms : 0
		);
		core.apply("recommended");
		core.notify();
		executor.schedule(rec, rec.plan, this.hooks.moveContext(rec));
		log.info("game-session: premove fired", { tabId: core.tabId, uci: chosen.uci, fireInMs });
		return true;
	}
}
