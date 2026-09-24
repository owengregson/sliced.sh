/**
 * tools/calibration/sim.ts — the bot on real human positions, the way the pipeline plays them.
 *
 * For one cell (chess.com time class × rating bucket R) the rows of each sampled (game, side) are
 * walked in ply order by `chains` independent chains. At every row a chain does what the
 * service worker does for an own move at target R:
 *
 *   1. `ownMoveMaiaElo` — the calibrated conditioning, opponent pressure and the clock/think
 *      context penalty (timing persona `tau` sampled per chain as the session samples it per game,
 *      form 0 as the session holds it) → Maia's query rating;
 *   2. Maia's answer at that rating, log-linearly interpolated between the row's cached grid
 *      policies (`PolicyGrid`);
 *   3. the human-depth frame `humanDepth(selfElo)` from the cached per-depth cycles;
 *   4. `selectMove` over the cached referee pool with the production `SelectionContext`
 *      (`hybrid`, unrestricted referee, the calibration table under test).
 *
 * The chain's per-game state follows the game that was actually played: after each draw the
 * previous-own-moves memory and the tilt trigger's reference score are set from the **human's**
 * move, because that is the move the next position came from. Every pick is judged by the same
 * referee frame as the human's move (`judge`), so bot and human numbers are paired per position.
 *
 * The parts live in `sim/`: the policy grid, the judge, the game grouping and the replay.
 */

import "../lib/defines";

export { type CellItem, type Game, groupGames } from "./sim/games";
export {
	CP_LOSS_CAP,
	type Judge,
	judgeFor,
	type MoveOutcome,
	NEAR_BEST_LOSS,
	type PositionShape,
	positionFacts,
} from "./sim/judge";
export { PolicyGrid } from "./sim/policy-grid";
export {
	type Draw,
	type SimManyOptions,
	type SimOptions,
	type SimRow,
	simulate,
	simulateMany,
} from "./sim/replay";
