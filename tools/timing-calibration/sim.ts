/**
 * tools/timing-calibration/sim.ts — the bot's clock-recorded think times on real human games,
 * the way the service worker plays them.
 *
 * Every selected (game, side) is replayed in ply order by `chains` independent chains; each chain
 * is one bot game at the human's advertised rating (a fresh `TimingModel` with the production
 * preset for the time control, persona from the chain's game id). The positions, clocks and the
 * opponent's moves and thinks are the recorded ones: at each own move the bot sees the context the
 * human saw and "plays" the human's move (so the situation label is the human's), and the time it
 * would have taken is what chess.com would record for it:
 *
 *   1. **Premove** (`PremoveArming.arm` → `QueuedPremove.enter` / `fireOnReply`). After its
 *      previous move the session arms a premove when `premoveCandidate` finds one for the reply it
 *      predicts; the engine-dependent part is computed once per row with the shipped function over
 *      cached frames (`premoveFacts`), the random gates are drawn per chain with the production
 *      probabilities (`premovePropensity` under the table, else the strength propensities). If
 *      the opponent then plays the predicted reply: a queueable candidate that the opponent's
 *      think left time to enter (arming searches + entry delay + the gesture) is a site premove,
 *      recorded as 0.1 s; otherwise the fast reply (`fireOnReply`), realised as the hand measured
 *      it (`FIRE_MS`).
 *   2. **Planned move**. `TimingModel.planMove` with the production `TimingContext` (the shipped
 *      ChessMimic band's cached distribution, the frame's lines, the ponder's expected reply,
 *      the book flag, the prior position, the hover square when the idle hand anticipated), then
 *      the executor: the search's preparation (`ownMoveBudget`'s movetime; a cache hit when the
 *      opponent played the predicted reply after the pre-analysis finished; the fast-reply cap
 *      when enabled), and the hand, which starts at `max(deadline − approach, preparation)` and
 *      takes `max(approach, natural touch)` unless the plan is an anticipated prepared touch
 *      (realised as planned). `observe` feeds the release back as the session does.
 *
 * The recorded value is `ceil(release / 100 ms) · 100 ms` (chess.com's tenth-second clock).
 *
 * Parts: `sim/replay-data.ts` (`loadReplay` and the per-row facts cache), `sim/premove-facts.ts`
 * (the engine-dependent half of the arm), `sim/chain.ts` (one chain's premove and planned-move
 * steps), `sim/latency.ts` (the latency model), `sim/types.ts` (options and results).
 */

import "../lib/defines";
import { chainStepper } from "./sim/chain";
import type { ReplayData, ReplaySide } from "./sim/replay-data";
import type { SimOptions, SimRowResult } from "./sim/types";

export { LATENCY, recordedMs } from "./sim/latency";
export type { PremoveFacts } from "./sim/premove-facts";
export { loadReplay, type ReplayData, type ReplayRow, type ReplaySide } from "./sim/replay-data";
export type { BotPath, SimOptions, SimRowResult } from "./sim/types";

/** Replay every side `chains` times; results keyed by row id. */
export async function simulate(
	data: ReplayData,
	opts: SimOptions,
	filter?: (s: ReplaySide) => boolean
): Promise<Map<string, SimRowResult>> {
	const results = new Map<string, SimRowResult>();
	for (const side of data.sides) {
		if (filter && !filter(side)) continue;
		if (side.rows.length === 0) continue;
		const chains = Array.from({ length: opts.chains }, (_, c) => chainStepper(side, c, opts));
		for (const rr of side.rows) {
			const res: SimRowResult = { id: rr.row.id, bot: [], path: [] };
			for (const chain of chains) {
				const d = await chain(rr);
				if (Number.isNaN(d.ms)) continue;
				res.bot.push(d.ms);
				res.path.push(d.path);
			}
			if (res.bot.length > 0) results.set(rr.row.id, res);
		}
	}
	return results;
}
