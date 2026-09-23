/**
 * Candidate-driven free pointer movement while waiting for the opponent ("pondering"); never
 * selects a piece. One call plans one *spell* of the turn's attention plan (owner, 2026-09-12): a
 * short first look, then active spells and stills alternating, their lengths set by the time
 * control, the opponent's elapsed think (attention decays), the game phase and whether a premove
 * or hold is armed. The caller refreshes candidates/geometry between spells and cancels on a turn
 * change. Without an attention context the spell is the pre-2026-09-12 bout.
 *
 * The parts live under `./opponent-exploration/`: `attention` schedules the spells, `spells`
 * plans one, `activities` are what an active spell does, and `timeline` is the hand's ledger
 * every activity spends its time through.
 */
import type { Rng } from "@core/rng";
import { OPPONENT_EXPLORATION as O, REPERTOIRE } from "./constants";
import { sampleRange, validRect } from "./geometry";
import { chooseSpell, spellCeiling, spellMs } from "./opponent-exploration/attention";
import { SpellPlanner } from "./opponent-exploration/spells";
import type { SpellBudget } from "./opponent-exploration/timeline";
import type {
	OpponentExplorationOptions,
	OpponentExplorationPlan,
} from "./opponent-exploration/types";

export { decideOpponentTurn } from "./opponent-exploration/attention";
export type {
	ExplorationActivity,
	ExplorationSide,
	ExplorationSpell,
	OpponentExplorationAction,
	OpponentExplorationOptions,
	OpponentExplorationPlan,
} from "./opponent-exploration/types";

/** Plan one finite spell. The caller refreshes candidates/geometry and cancels on a turn change. */
export function planOpponentExploration(
	opts: OpponentExplorationOptions,
	rng: Rng
): OpponentExplorationPlan {
	const lowTime = opts.policy?.lowTime === true;
	const ownOnly = lowTime || opts.policy?.ownOnly === true;
	const attention = lowTime ? undefined : opts.attention;
	const spell = chooseSpell(opts, attention, rng);
	const durationMs = Math.min(spellCeiling(opts.maxMs), spellMs(spell, opts, attention, rng));
	const budget: SpellBudget = { total: durationMs, spent: 0, activeUntil: durationMs };
	if (!attention) {
		const frac = sampleRange(lowTime ? O.lowTimeActiveFrac : O.activeFrac, rng);
		budget.activeUntil = durationMs * frac;
	}
	const plan = new SpellPlanner(opts, ownOnly, budget, rng, spell);
	if (!validRect(opts.geometry.boardRect)) {
		plan.rest(durationMs);
		return plan.finish();
	}
	if (
		opts.attention?.repertoire &&
		(opts.attention.repertoire.premovePending ||
			opts.attention.armed ||
			lowTime ||
			durationMs < REPERTOIRE.minWindowMs ||
			!Number.isFinite(opts.attention.myClockMs) ||
			opts.attention.myClockMs < REPERTOIRE.lowClockMs)
	)
		plan.suppressRepertoire();
	else if (spell === "still") plan.still();
	else if (spell === "glance") plan.glance();
	else if (opts.attention?.repertoire) plan.repertoireBout();
	else if (!attention) plan.legacyBout(lowTime);
	else plan.active(spell === "first");
	return plan.finish();
}
