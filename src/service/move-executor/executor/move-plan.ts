/**
 * Turning a recommendation into the hand's `ExecutionPlan`: the motor profile for this move, the
 * square targets, the exploration inputs and the committed input style. Pure over the seeded
 * streams it is handed; the executor calls these in the order the draws must happen.
 */

import type { BoardGeometryReply, ExpectedMove } from "@core/constants/messages";
import { autoClickProbFor } from "@core/motor/input-style";
import { perGameProfile, perMoveProfile, profileFor } from "@core/motor/motor-profile";
import type {
	BoardGeometry,
	ExecutionPlan,
	InputStyle,
	MotorMoveKind,
	MotorProfile,
} from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { Recommendation, Site } from "@typedefs/game";
import { candidatesFromLines } from "./move-facts";
import type { ExecutorGameConfig, MoveContext } from "./types";

/** What the adapter is asked to observe for this move. */
export function expectedMoveOf(rec: Recommendation): ExpectedMove {
	const expected: ExpectedMove = {
		from: rec.chosen.from,
		to: rec.chosen.to,
		beforeFen: rec.fen,
	};
	if (rec.chosen.promotion) expected.promotion = rec.chosen.promotion;
	return expected;
}

/** The per-move motor profile: the persona's per-game hand, then this move's own sample. */
export function moveMotorProfile(
	config: ExecutorGameConfig,
	moveKind: MotorMoveKind,
	moveRng: Rng
): MotorProfile {
	return perMoveProfile(
		perGameProfile(
			profileFor(config.persona, config.tcClass, moveKind),
			createRng(`${config.gameSeed}:hand`)
		),
		moveRng
	);
}

export interface ExecutionPlanInput {
	tabId: number;
	site: Site;
	rec: Recommendation;
	ctx: MoveContext;
	config: ExecutorGameConfig;
	geo: BoardGeometry;
	reply: BoardGeometryReply;
	readAt: number;
	motor: MotorProfile;
	/** Entered during the opponent's turn: a premove or a scramble hold. */
	premove: boolean;
}

export function executionPlanOf(input: ExecutionPlanInput): ExecutionPlan {
	const { rec, ctx, config, geo } = input;
	const fromRect = geo.squareRect(rec.chosen.from);
	const toRect = geo.squareRect(rec.chosen.to);
	const plan: ExecutionPlan = {
		tabId: input.tabId,
		site: input.site,
		from: {
			x: fromRect.left + fromRect.width / 2,
			y: fromRect.top + fromRect.height / 2,
			rect: fromRect,
			square: rec.chosen.from,
		},
		to: {
			x: toRect.left + toRect.width / 2,
			y: toRect.top + toRect.height / 2,
			rect: toRect,
			square: rec.chosen.to,
		},
		motor: input.motor,
		motorSpeed: config.motorSpeed ?? 1,
		// `premove` here means "entered as a premove", which is what relaxes the hand's own
		// destination guard — not merely "the §7.4 policy chose it" (a premove played after the
		// predicted reply landed is an ordinary move and is guarded like one).
		expected: { san: rec.chosen.san, uci: rec.chosen.uci, premove: input.premove },
		geometry: { reply: input.reply, readAt: input.readAt },
		exploration: {
			...(ctx.repertoire
				? {
						repertoire: {
							...ctx.repertoire,
							premovePending: input.premove || ctx.repertoire.premovePending === true,
						},
					}
				: {}),
			candidates: ctx.candidates ?? candidatesFromLines(rec),
			nReasonable: ctx.nReasonable ?? Math.max(1, rec.lines.length),
			myClockMs: ctx.myClockMs ?? 0,
			persona: config.persona,
			previewScale: config.previewScale,
			legalDestinations: ctx.legalDestinations ?? (() => []),
		},
	};
	if (rec.chosen.promotion) plan.promotion = rec.chosen.promotion;
	return plan;
}

/**
 * `Settings.execution.inputMode`: a premove or a hold is always a drag (the site's premove
 * UI is built around it, and a hold *is* a drag paused mid-way); a promotion too, so the
 * picker click stays the one click of the move. Otherwise the setting, with `auto` drawing
 * per move from its own stream so the motor's per-move sampling is untouched by the choice.
 */
export function inputStyleOf(
	config: ExecutorGameConfig,
	rec: Recommendation,
	ctx: MoveContext,
	premove: boolean
): InputStyle {
	const styleRng = createRng(`${config.gameSeed}:${rec.fen}:${rec.chosen.uci}:style`);
	const clickProb = autoClickProbFor(rec.chosen.from, rec.chosen.to, ctx.myClockMs);
	return premove || rec.chosen.promotion !== undefined
		? "drag"
		: config.inputMode === "click"
			? "click"
			: config.inputMode === "auto" && styleRng.chance(clickProb)
				? "click"
				: "drag";
}
