/**
 * Max-strength mode (owner, 2026-09-15): "when elo rating bar is 3800 (aka whatever the max is,
 * basically just when its at 100%), just play the absolute best possible move in every situation
 * with the deepest thought we can and maximal performance - just the strongest possible outcome."
 *
 * The mode is on exactly when the session's **active** target reaches `LIMITS.eloMax` — the slider
 * at 100 %, or an opponent-matched target clamped to the ceiling — and nowhere below it
 * (`isMaxStrength`, `src/core/strength/max-strength.ts`). What it changes, and why the human timing
 * model stays out of it (C7), is documented where each knob below is read.
 *
 * C1 registry: every number the mode adds lives here, once.
 */

import { LIMITS } from "./limits";

export const MAX_STRENGTH = {
	/**
	 * "with the deepest thought we can": the move-deciding search carries no depth ceiling of its
	 * own. Stockfish ends iterative deepening at `MAX_PLY` (246), so `go depth 245` is the deepest
	 * request it accepts; the wall-clock window below is what actually ends the search. The depth is
	 * explicit rather than absent so the analysis cache (`EngineController.minDepthFor`, depth − 2)
	 * can never answer this search with a shallower frame already in hand.
	 */
	searchDepth: 245,
	/**
	 * "the deepest thought we can": the move-deciding search follows one principal variation, the
	 * most depth per unit of time. The own-move search before it keeps its MultiPV frame — the timing
	 * model's features and the panel read those lines — so this narrows only the search that picks
	 * the move.
	 */
	multiPv: 1,
	/**
	 * "the deepest thought we can" without moving faster than a human: the deep search runs until the
	 * hand must start its approach — `plan.deadlineMs − plan.window.approachMs − handReserveMs` — so
	 * the move still lands at the timing model's own deadline. The reserve covers the stop receipt
	 * (`SEARCH_BUDGET.stopReceiptMs`), the executor's minimum execution (`EXECUTOR.minExecutionMs`)
	 * and the geometry round trip before the first pointer event; `max-strength.test.ts` pins it
	 * above the first two.
	 */
	handReserveMs: 400,
	/**
	 * "the strongest possible outcome": a window shorter than this cannot search deeper than the move
	 * search that already answered (it ran at least `SEARCH_BUDGET.minMovetimeMs` on a warm hash), so
	 * no deep search is started and that search's best move is played.
	 */
	minSearchMs: 300,
	/**
	 * "just the strongest possible outcome" never means losing on time: the deep search, counted from
	 * the moment the position's search began, spends at most this share of the clock we had. The
	 * timing model's own allocation sits far below it (≈ 4 % of a 3+2 clock), so it binds only on a
	 * long-think tail — and there the search stops while the hand still waits out the planned think.
	 */
	clockFraction: 0.1,
	/**
	 * "maximal performance": the transposition table at the largest size the registry allows, whatever
	 * the stored setting. Not raised past `LIMITS.hashMbMax` for this mode: the offscreen document
	 * already holds two full-network engines (≈ 650 MiB peak each while a network loads, 1.3 GiB
	 * measured together in Chrome 152), and a larger table on top of that has never been measured in
	 * a browser — an out-of-memory trap mid-game is the weakest possible outcome.
	 */
	hashMb: LIMITS.hashMbMax,
} as const;
