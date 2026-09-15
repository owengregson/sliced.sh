/**
 * The session's side of the Maia-3 wiring (2026-09-13, H6.3 / H7.3 / H8 of
 * `docs/research/human-move-selection-ideas-2026-09-13.md`), kept pure so `session.ts` only
 * orchestrates:
 *
 *   - `commitMaiaSize` — H6.3: one size per game, chosen from the target at game start (or at an
 *     explicit target change), never from a per-move target that drifts across a band edge.
 *   - `predictedPolicyInputs` — H7.3: the query for the *predicted* position, issued during the
 *     opponent's turn with exactly the inputs the own-move pipeline would use, so the answer is
 *     the one the pipeline would have asked for when the reply lands.
 *   - `attachPredictedPolicy` — H8: the pre-inferred answer as the hold's `ctx.maia`, when it is
 *     for the position the hold is chosen from.
 */

import { type PositionHistory, positionKey } from "@core/chess/history";
import { MAIA, type MaiaSize } from "@core/constants/maia";
import { MAIA_SEARCH } from "@core/constants/search";
import { maiaConditioningElo, maiaSizeFor, usesMaia, usesMaiaPrior } from "@core/policy/maia-size";
import { policyQueryIdentity } from "@core/policy/policy-query";
import type { PolicyInferenceInputs, PolicyResult } from "@core/policy/types";
import type { SelectionContext } from "@core/strength/types";
import type { EvalLine } from "@typedefs/engine";
import type { Settings } from "@typedefs/settings";
import { maiaHistoryFens, type OwnMoveBudgetInput, ownMoveMaiaElo } from "./recommendation";

/** A Maia answer the session holds for one position (`RecommendationInput.policyAnswer`). */
export interface PredictedPolicyAnswer {
	identity: string;
	fen: string;
	result: PolicyResult;
	selfElo: number;
	historyPlies: number;
	/**
	 * H10: the engine's known best moves the pre-analysis of this position was **shaped with**
	 * (`knownTopMovesFor`). Present exactly when the pre-analysis ran the Maia-shaped search, so
	 * the own-move pipeline builds the identical root set and the cache answers.
	 */
	knownTopMoves?: string[];
}

/**
 * H10: the engine's best moves for the *predicted* position that are known before it is searched
 * — the continuation of every ponder line on the opponent's position that starts with `reply`
 * (`pvUci[1]`), then `extra` (the §7.4 premove's own pick for that position) — at most
 * `MAIA_SEARCH.shaped.knownTopMoves`, duplicates folded, first come first. Legality is the root
 * set builder's to check. `[]` when nothing is known (the search then runs over Maia's roots only).
 */
export function knownTopMovesFor(
	ponderLines: readonly EvalLine[],
	reply: string,
	extra: readonly string[] = []
): string[] {
	const out: string[] = [];
	const add = (uci: string | undefined): void => {
		if (uci === undefined || uci === "" || out.includes(uci)) return;
		if (out.length < MAIA_SEARCH.shaped.knownTopMoves) out.push(uci);
	};
	for (const line of ponderLines) if (line.pvUci[0] === reply) add(line.pvUci[1]);
	for (const uci of extra) add(uci);
	return out;
}

/**
 * `pending`'s value if it settles within `ms` (a virtual-clock timer in the service worker),
 * otherwise `null` — the promise itself is left running. H10's bounded wait for the
 * pre-inference on the opponent's clock (`MAIA_SEARCH.shaped.preInferWaitMs`).
 */
export function settledWithin<T>(pending: Promise<T>, ms: number): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), Math.max(0, ms));
		pending.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			}
		);
	});
}

/**
 * H6.3: the size a game commits to, and what it was committed from. The session locks it once
 * the game's first move has been decided: an opponent-matched target drifting across a band edge
 * no longer switches it. Before that (the opponent's rating arriving with the game) the
 * commitment follows the target, since that is still "game start".
 */
export interface MaiaCommitment {
	/** `null` → Maia is not queried for this game (target above `MAIA.prior.eloMax`). */
	size: MaiaSize | null;
	/** The derived target the size was chosen from. */
	targetElo: number;
	/** The stored slider value and the match switch at commit time (an explicit change re-commits). */
	settingsTarget: number;
	matchOpponent: boolean;
}

/**
 * The resident size for direct and prior selection; no model above the prior ceiling. `null` when Maia is not queried at all.
 */
export function maiaSizeForGame(targetElo: number): MaiaSize | null {
	if (usesMaia(targetElo)) return maiaSizeFor(targetElo);
	if (usesMaiaPrior(targetElo)) return MAIA.prior.size;
	return null;
}

export function commitMaiaSize(
	targetElo: number,
	settings: { targetElo: number; matchOpponentRating: boolean }
): MaiaCommitment {
	return {
		size: maiaSizeForGame(targetElo),
		targetElo,
		settingsTarget: settings.targetElo,
		matchOpponent: settings.matchOpponentRating,
	};
}

/** Does a settings write change what the commitment was made from (the user's explicit act)? */
export function commitmentSuperseded(
	commit: MaiaCommitment,
	settings: { targetElo: number; matchOpponentRating: boolean }
): boolean {
	return (
		settings.targetElo !== commit.settingsTarget ||
		settings.matchOpponentRating !== commit.matchOpponent
	);
}

export interface PredictedPolicyInput {
	/** The predicted position (after our move and the expected reply). */
	fen: string;
	/** The game's history through the expected reply (its replay reaches `fen`). */
	history: PositionHistory;
	/** The own-move budget input for the predicted position — what `ownMoveBudget` is given too. */
	position: OwnMoveBudgetInput;
	settings: Settings;
	/** H6.3's committed size; `null` → Maia is not queried for this game. */
	size: MaiaSize | null;
	opponentElo: number | null;
}

export interface PredictedPolicyQuery {
	identity: string;
	inputs: PolicyInferenceInputs;
	selfElo: number;
	historyPlies: number;
}

/**
 * H7.3: the query the own-move pipeline would issue for `fen` — the game's size (the H15 prior's
 * above `MAIA.eloMax`), the history window, the pipeline's own rating arithmetic
 * (`ownMoveMaiaElo`: `maiaSelfElo` over `pressureTerms`, the slider offset and H5's context
 * penalty, capped by `maiaConditioningElo`) and the opponent rating
 * fallback (`MAIA.oppoFallbackSelf`). `null` when Maia is not queried for this target.
 */
export function predictedPolicyInputs(input: PredictedPolicyInput): PredictedPolicyQuery | null {
	const size = input.size;
	const targetElo = input.position.targetElo ?? input.settings.strength.targetElo;
	if (size === null || (!usesMaia(targetElo) && !usesMaiaPrior(targetElo))) return null;
	const prior = usesMaiaPrior(targetElo);
	const elo = ownMoveMaiaElo(input.position, input.settings);
	const selfElo = maiaConditioningElo(elo.selfElo);
	const historyFens = maiaHistoryFens(input.history, input.fen);
	const inputs: PolicyInferenceInputs = {
		size: prior ? MAIA.prior.size : size,
		fen: input.fen,
		historyFens,
		selfElo,
		oppoElo: input.opponentElo ?? selfElo,
	};
	return {
		inputs,
		identity: policyQueryIdentity({
			inputs,
			mode: prior ? "prior" : "maia",
			selectionMode: input.settings.strength.selectionMode,
			history: input.history,
		}),
		selfElo,
		historyPlies: historyFens.length,
	};
}

/** The same board: placement, side, castling and a *usable* en-passant square (`positionKey`). */
export function samePosition(a: string, b: string): boolean {
	return positionKey(a) === positionKey(b);
}

/**
 * H7.3: the answer to hand the pipeline for `fen`, re-keyed to the *page's* FEN string so the
 * pipeline's exact-match check hits, or `null` when the answer has a different query identity.
 */
export function policyAnswerFor(
	predicted: PredictedPolicyAnswer | null,
	fen: string,
	identity: string | undefined
): PredictedPolicyAnswer | null {
	if (
		!predicted ||
		identity === undefined ||
		predicted.identity !== identity ||
		!samePosition(predicted.fen, fen)
	)
		return null;
	return predicted.fen === fen ? predicted : { ...predicted, fen };
}

/** H8: the pre-inferred answer becomes the hold's `ctx.maia` when it is for the hold's position. */
export function attachPredictedPolicy(
	ctx: SelectionContext,
	predicted: PredictedPolicyAnswer | null,
	identity: string | undefined
): boolean {
	if (!usesMaia(ctx.targetElo) && !usesMaiaPrior(ctx.targetElo)) return false;
	const answer = policyAnswerFor(predicted, ctx.fen, identity);
	if (!answer) return false;
	ctx.maia = answer.result;
	return true;
}
