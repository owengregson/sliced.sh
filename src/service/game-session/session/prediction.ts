/**
 * Work done on the opponent's clock for the position we expect to face: the Maia answer for it
 * (H7.3, pre-inferred), the engine's analysis of it (Appendix E §4.5, pre-analysed and — H10 —
 * shaped exactly as the own-move search will be), and the policy queries both are keyed by. What
 * this produces is only ever *used* when it is still valid for the position that actually arrived.
 */

import { historyKey, type PositionHistory } from "@core/chess/history";
import { applyMoves } from "@core/chess/san";
import { MAIA } from "@core/constants/maia";
import { MAIA_SEARCH } from "@core/constants/search";
import type { AnalysisHandle, AnalysisRequest, AnalysisUpdate } from "@core/engine/types";
import { log } from "@core/logger";
import type { PolicyResult } from "@core/policy/types";
import { isMaxStrength } from "@core/strength/max-strength";
import { isPremoveSpeed } from "@core/strength/premove";
import { errorMessage } from "@core/util/errors";
import type { EvalLine } from "@typedefs/engine";
import type { PositionSnapshot } from "@typedefs/game";
import {
	knownTopMovesFor,
	maiaSizeForGame,
	type PredictedPolicyAnswer,
	type PredictedPolicyQuery,
	policyAnswerFor,
	predictedPolicyInputs,
	samePosition,
	settledWithin,
} from "../maia-session";
import type { PonderController } from "../ponder";
import {
	maiaSearchMode,
	type OwnMoveBudgetInput,
	ownMoveBudget,
	ownMoveClockRace,
	refereeElo,
	type ShapedSearchPlan,
	shapedSearchPlan,
} from "../recommendation";
import type { SessionCore } from "./core";
import type { MaiaWarmup } from "./maia-warmup";
import type { PremoveArm } from "./premove";

/** `preAnalyse`'s answer for this opponent turn: what a hold candidate is chosen from. */
export interface PredictedAnalysis {
	reply: string;
	fen: string;
	lines: EvalLine[];
	request: AnalysisRequest;
	generation: number;
	bestmove: string | null;
	comparison?: AnalysisUpdate;
}

export interface PredictionHooks {
	/** The armed §7.4 premove, read at the moment it matters (it can be dropped mid-await). */
	armedPremove(): PremoveArm | null;
	/** H8: the pre-inferred answer arrived — gate the armed premove with it. */
	gatePremove(reply: string, predicted: string, result: PolicyResult): void;
}

export class Prediction {
	/**
	 * H7.3: the Maia answer for the predicted position, inferred during the opponent's turn beside
	 * `analysis`. Handed to the pipeline as `policyAnswer` when that position arrives, to the hold
	 * as `ctx.maia` (H8), and to the premove gate (H8). Cleared with `analysis`.
	 */
	policy: PredictedPolicyAnswer | null = null;
	/** `preAnalyse`'s answer for this opponent turn: what a hold candidate is chosen from. */
	analysis: PredictedAnalysis | null = null;
	/** The pre-inference in flight, so a position change can abort it. */
	private policyAc: AbortController | null = null;
	/** Appendix E §4.5: the in-flight pre-analysis of the position the expected reply leads to. */
	private preAnalysis: AnalysisHandle | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly maia: MaiaWarmup,
		private readonly hooks: PredictionHooks
	) {}

	/** Drop both answers (the position they were for is no longer the live one). */
	forget(): void {
		this.analysis = null;
		this.policy = null;
	}

	/** Drop the pre-inference in flight (the position it was for is no longer the live one). */
	abortPolicy(): void {
		const ac = this.policyAc;
		this.policyAc = null;
		ac?.abort();
	}

	/** Stop the pre-analysis search in flight, if any. */
	stopPreAnalysis(): void {
		const pre = this.preAnalysis;
		this.preAnalysis = null;
		if (pre) void pre.stop();
	}

	/** The own-move budget input for `fen` at `ply`, from the clocks of `snapshot`. */
	policyPosition(snapshot: PositionSnapshot, fen: string, ply: number): OwnMoveBudgetInput | null {
		const core = this.core;
		const me = snapshot.myColor;
		const timing = core.timing;
		if (me === null || !timing) return null;
		const position = {
			fen,
			ply,
			targetElo: core.targetElo(),
			form: core.form.value,
			myClockMs: core.remainingClockMs(snapshot, me),
			oppClockMs: core.remainingClockMs(snapshot, me === "w" ? "b" : "w"),
			timeControl: core.currentTimeControl(),
			tau: timing.persona.tau,
			budgetUsedRatio: core.budgetUsedRatio(snapshot),
		};
		const mode = {
			targetElo: position.targetElo,
			policy: core.deps.policy !== undefined,
			clockRace: ownMoveClockRace(position) !== null,
		};
		return { ...position, maia: maiaSearchMode(mode) };
	}

	policyQueryFor(
		snapshot: PositionSnapshot,
		fen: string,
		history: PositionHistory,
		ply: number
	): PredictedPolicyQuery | null {
		const core = this.core;
		const position = this.policyPosition(snapshot, fen, ply);
		if (!core.mayAct() || !position || ownMoveClockRace(position) !== null) return null;
		return predictedPolicyInputs({
			fen,
			history,
			position,
			settings: core.settings(),
			size: maiaSizeForGame(core.targetElo()),
			opponentElo: core.opponentInfo?.ratingEstimate ?? null,
		});
	}

	/** The held answer when it is for `snapshot` itself under today's query identity. */
	currentPolicyFor(
		snapshot: PositionSnapshot,
		candidate = this.policy
	): PredictedPolicyAnswer | null {
		const query = this.policyQueryFor(
			snapshot,
			snapshot.fen,
			this.core.historyFor(snapshot.fen),
			snapshot.ply
		);
		const answer = policyAnswerFor(candidate, snapshot.fen, query?.identity);
		return answer && query
			? { ...answer, selfElo: query.selfElo, historyPlies: query.historyPlies }
			: null;
	}

	/**
	 * Appendix E §4.5: "a hit … common when the opponent plays the predicted move: the ponder result
	 * for that FEN is already there". It never was. The opponent-turn ponder is keyed under the
	 * *opponent's* position, and §7.4's own `m r` gate search is MultiPV 2 at 120 ms — below the
	 * own-move `K` (3–8) and far below the cache's `depthCap − 2` gate — so nothing this session
	 * produced could ever answer its next own-move search, and every move paid the full search again.
	 *
	 * This is that search, run early: the position we will face if the opponent plays the reply we
	 * expect, analysed at **exactly the budget the own-move search will ask for** (`ownMoveBudget`),
	 * which is what puts its depth inside the slack. Engine time on the opponent's clock is free, and
	 * the own-move search supersedes it by priority if the reply comes first.
	 *
	 * Raising `PREMOVE.replyMultiPv` instead would not have worked: the MultiPV is only one of the
	 * two gates, and a 120 ms search cannot reach `depthCap − 2` on any machine. Those constants are
	 * Appendix E §3.1 normative and sized for a *gate decision*, so they stand.
	 *
	 * A prediction already in hand is used at any speed, but *harvesting* one — stopping the
	 * `go infinite` so it settles — happens only at a **premove speed** (`isPremoveSpeed`, i.e.
	 * bullet / blitz), because at rapid and classical that trades §7.5's continuous ponder for a head
	 * start on a depth-0 guess at speeds where the own-move search already fits inside the planned
	 * think. `dispose()` / `cancelInFlight()` / `stopSearch()` all stop the search this issues.
	 */
	async preAnalyse(snapshot: PositionSnapshot, ponderer: PonderController): Promise<void> {
		const core = this.core;
		const engine = core.deps.engine;
		const timing = core.timing;
		const myColor = snapshot.myColor;
		if (!engine || !timing || myColor === null || !core.mayAct()) return;
		const generation = core.workGeneration;
		// The prediction. §7.4 produces one on the classes it runs on, and only when its own draw
		// came up; otherwise the `go infinite` ponder is still running and is *holding* the answer —
		// it settles on `stop`. Stopping it early costs depth on the opponent's position, which is
		// only ever read for this prediction; the pre-analysis then spends the rest of that time on
		// the position we are actually about to face, and the ponder is restarted underneath it.
		let reply = this.hooks.armedPremove()?.reply ?? ponderer.expectedReply(snapshot.fen);
		if (reply === null) {
			// Harvesting means stopping the `go infinite` to make it settle, and that is only worth
			// doing where the prediction buys something. At a premove speed §7.4 has usually already
			// interrupted the ponder for its own 150 ms MultiPV-3 prediction, so the harvest costs
			// little and the latency it saves is the whole point. At rapid and classical it would cut
			// §7.5's continuous ponder off after a couple of round trips and spend 1.0–1.5 s on a
			// position predicted by an essentially depth-0 search — while the own-move search there
			// (1000–1500 ms) already fits inside a 4–16 s planned think, so there is no latency to
			// win. Measured on the wire before this gate: `go infinite → go depth 22 movetime 1000 →
			// go infinite` on every rapid opponent turn.
			//
			// Max-strength mode (owner, 2026-09-15: "the deepest thought we can") harvests at every
			// speed: the own-move search then starts from a cache hit on the predicted position and a
			// warm hash, and the deep move search gets the time that search would have taken.
			if (
				!isPremoveSpeed(core.currentTimeControl()) &&
				!core.racePolicyFor(snapshot) &&
				!isMaxStrength(core.targetElo())
			)
				return;
			await ponderer.stop();
			if (core.disposed || core.snapshot !== snapshot || generation !== core.workGeneration) return;
			reply = ponderer.expectedReply(snapshot.fen);
		}
		if (reply === null) {
			await this.resumePonder(snapshot, ponderer);
			return;
		}
		const predicted = applyMoves(snapshot.fen, [reply]);
		if (predicted === null) {
			await this.resumePonder(snapshot, ponderer);
			return;
		}
		const position = {
			fen: predicted,
			ply: snapshot.ply + 1,
			targetElo: core.targetElo(),
			form: core.form.value,
			myClockMs: core.remainingClockMs(snapshot, myColor),
			oppClockMs: core.remainingClockMs(snapshot, myColor === "w" ? "b" : "w"),
			timeControl: core.currentTimeControl(),
			tau: timing.persona.tau,
			budgetUsedRatio: core.budgetUsedRatio(snapshot),
		};
		// The same Maia-or-not decision the own-move search will make for this position: Maia's
		// referee search is full strength with the sampling breadth, and the cache keys on both, so
		// a pre-analysis at the native `UCI_Elo` could never answer it.
		const maia = maiaSearchMode({
			targetElo: position.targetElo,
			policy: core.deps.policy !== undefined,
			clockRace: ownMoveClockRace(position) !== null,
		});
		// H4 (2026-09-13): the human-depth side frame is part of the cache identity, so the
		// pre-analysis asks for exactly what `ownMoveBudget` will ask for on our move.
		const budget = ownMoveBudget({ ...position, maia }, core.settings());
		// H10: the engine's own best moves for the predicted position, known before it is searched —
		// the ponder's continuation after `reply`, and the §7.4 premove's pick when it is for this
		// very position. Forced into the shaped root set so the true best move is always scored.
		const premove = this.hooks.armedPremove();
		const knownTopMoves = knownTopMovesFor(
			ponderer.latestLines(snapshot.fen),
			reply,
			premove && premove.reply === reply && samePosition(premove.fen, predicted)
				? [premove.chosen.uci]
				: []
		);
		// H7.3: the Maia query for the same position goes out beside the search, on their clock.
		const inferred = this.preInfer(snapshot, predicted, reply, {
			...position,
			maia,
		});
		// H10: on their clock, wait (bounded) for that answer and shape the pre-analysis exactly as
		// the own-move search will be shaped — the same roots, breadth, movetime and flag, from the
		// same pure `shapedSearchPlan` — so a correct prediction is a cache hit exactly as before.
		// The answer is re-held *with* the known moves it was shaped with; the pipeline then builds
		// the identical set. No answer in time → the broad pre-analysis, as before.
		let shaped: ShapedSearchPlan | null = null;
		if (maia && MAIA_SEARCH.shaped.enabled) {
			const answer = await settledWithin(inferred, MAIA_SEARCH.shaped.preInferWaitMs);
			if (core.disposed || core.snapshot !== snapshot || generation !== core.workGeneration) return;
			if (answer && this.policy === answer) {
				shaped = shapedSearchPlan(answer.result, predicted, knownTopMoves, budget, position.targetElo);
				if (shaped) this.policy = { ...answer, knownTopMoves };
			}
		}
		if (generation !== core.workGeneration || !core.mayAct()) return;
		const search = shaped?.budget ?? budget;
		const request: AnalysisRequest = {
			id: `${core.tabId}-predicted-${core.now()}`,
			targetElo: position.targetElo,
			fen: core.historyFor(snapshot.fen).fen,
			moves: [...core.historyFor(snapshot.fen).moves, reply],
			multiPv: search.multiPv,
			limit: { movetimeMs: Math.round(search.movetimeMs), depth: search.depthCap },
			priority: "ponder",
		};
		if (search.featureDepth !== undefined) request.featureDepth = search.featureDepth;
		if (shaped) {
			request.searchmoves = [...shaped.searchmoves];
			request.shaped = true;
		}
		const elo = refereeElo(position.targetElo, maia);
		if (elo !== undefined) request.elo = elo;
		try {
			const handle = engine.analyse(request);
			this.preAnalysis = handle;
			const result = await handle.result;
			if (
				this.preAnalysis === handle &&
				core.snapshot === snapshot &&
				generation === core.workGeneration &&
				core.mayAct() &&
				result.status === "complete" &&
				result.final.lines.length > 0
			)
				this.analysis = {
					reply,
					fen: predicted,
					lines: result.final.lines,
					request,
					generation,
					bestmove: result.bestmove,
					...(result.atFeatureDepth ? { comparison: result.atFeatureDepth } : {}),
				};
			log.debug("game-session: pre-analysed the predicted position", {
				tabId: core.tabId,
				reply,
				depth: result.final.depth,
				status: result.status,
			});
		} catch (error) {
			log.debug("game-session: pre-analysis unavailable", { error: errorMessage(error) });
		} finally {
			if (generation === core.workGeneration) this.preAnalysis = null;
		}
		// §6.4: the rest of the opponent's clock goes back to pondering their position — the engine
		// must not sit idle for the remainder of a long turn.
		if (generation === core.workGeneration) await this.resumePonder(snapshot, ponderer);
	}

	/** The pre-analysis, when it still answers exactly the search the own move would ask for. */
	validAnalysis(snapshot: PositionSnapshot): PredictedAnalysis | null {
		const core = this.core;
		const analysed = this.analysis;
		if (!analysed || analysed.generation !== core.workGeneration) return null;
		const root = core.historyFor(snapshot.fen);
		const history = { fen: root.fen, moves: [...root.moves, analysed.reply] };
		const position = this.policyPosition(snapshot, analysed.fen, snapshot.ply + 1);
		if (!position || !samePosition(applyMoves(snapshot.fen, [analysed.reply]) ?? "", analysed.fen))
			return null;
		const query = this.policyQueryFor(snapshot, analysed.fen, history, snapshot.ply + 1);
		const answer = policyAnswerFor(this.policy, analysed.fen, query?.identity);
		const budget = ownMoveBudget(position, core.settings());
		const shaped =
			position.maia && answer?.knownTopMoves
				? shapedSearchPlan(answer.result, analysed.fen, answer.knownTopMoves, budget, core.targetElo())
				: null;
		const expected = shaped?.budget ?? budget;
		const request = analysed.request;
		if (
			request.targetElo !== core.targetElo() ||
			request.elo !== refereeElo(core.targetElo(), position.maia === true) ||
			request.multiPv !== expected.multiPv ||
			request.limit.depth !== expected.depthCap ||
			request.featureDepth !== expected.featureDepth ||
			request.shaped !== (shaped ? true : undefined) ||
			JSON.stringify([...(request.searchmoves ?? [])].sort()) !==
				JSON.stringify([...(shaped?.searchmoves ?? [])].sort()) ||
			historyKey(request.fen, request.moves) !== historyKey(history.fen, history.moves)
		)
			return null;
		return analysed;
	}

	/**
	 * H7.3: pre-*infer* the predicted position. `preAnalyse` already builds the predicted FEN and
	 * its history during the opponent's turn; this issues the Maia query for it at the same moment,
	 * with exactly the inputs the own-move pipeline uses (`predictedPolicyInputs`), so the answer is
	 * instant when the reply is the expected one — the prerequisite for H8 (the hold and the premove
	 * gate). Costs nothing on our clock; aborted by any position change (`cancelInFlight`). Never
	 * throws. Resolves with the answer as held (`policy`), or `null` when none was held — H10's
	 * pre-analysis waits on it, bounded.
	 */
	private preInfer(
		snapshot: PositionSnapshot,
		predicted: string,
		reply: string,
		position: OwnMoveBudgetInput
	): Promise<PredictedPolicyAnswer | null> {
		const core = this.core;
		const policy = core.deps.policy;
		if (!policy || !core.mayAct() || ownMoveClockRace(position) !== null)
			return Promise.resolve(null);
		const root = core.historyFor(snapshot.fen);
		// The pipeline's own arithmetic over the same `OwnMoveBudgetInput` the pre-analysis was
		// sized by (`ownMoveMaiaElo`), so the answer is the one the own-move query would have asked for.
		const query = predictedPolicyInputs({
			fen: predicted,
			history: { fen: root.fen, moves: [...root.moves, reply] },
			position,
			settings: core.settings(),
			size: this.maia.size(),
			opponentElo: core.opponentInfo?.ratingEstimate ?? null,
		});
		if (!query) return Promise.resolve(null);
		this.abortPolicy();
		const ac = new AbortController();
		this.policyAc = ac;
		let pending: Promise<PolicyResult | null>;
		try {
			pending = policy
				.infer(query.inputs, { budgetMs: MAIA.inferenceBudgetMs, signal: ac.signal })
				.catch((error: unknown) => {
					log.debug("game-session: pre-inference failed", { error: errorMessage(error) });
					return null;
				});
		} catch (error) {
			log.debug("game-session: pre-inference refused", { error: errorMessage(error) });
			pending = Promise.resolve(null);
		}
		return pending.then((result) => {
			if (
				this.policyAc !== ac ||
				!result ||
				result.size !== query.inputs.size ||
				ac.signal.aborted ||
				core.disposed ||
				core.snapshot !== snapshot ||
				!core.mayAct()
			)
				return null;
			this.policyAc = null;
			const currentRoot = core.historyFor(snapshot.fen);
			const current = this.policyQueryFor(
				snapshot,
				predicted,
				{ fen: currentRoot.fen, moves: [...currentRoot.moves, reply] },
				snapshot.ply + 1
			);
			if (current?.identity !== query.identity) return null;
			const answer: PredictedPolicyAnswer = {
				identity: query.identity,
				fen: predicted,
				result,
				selfElo: query.selfElo,
				historyPlies: query.historyPlies,
			};
			this.policy = answer;
			log.debug("game-session: pre-inferred the predicted position", {
				tabId: core.tabId,
				reply,
				size: result.size,
				selfElo: Math.round(query.selfElo),
				historyPlies: query.historyPlies,
				ms: result.ms ?? null,
			});
			this.hooks.gatePremove(reply, predicted, result);
			return answer;
		});
	}

	/** Put the opponent-turn ponder back, unless the position (or the switch) has moved on. */
	async resumePonder(snapshot: PositionSnapshot, ponderer: PonderController): Promise<void> {
		const core = this.core;
		if (core.disposed || core.snapshot !== snapshot || !core.mayAct()) return;
		if (ponderer.isRunning()) return;
		const history = core.historyFor(snapshot.fen);
		await ponderer.start("opponent", history.fen, history.moves);
	}
}
