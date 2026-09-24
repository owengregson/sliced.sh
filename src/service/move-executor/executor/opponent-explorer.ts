/**
 * The idle hand during the opponent's turn (§9.4): cancellable free movement — rests, drifts and
 * pondering over the position — in bouts planned by `planOpponentExploration`. It never presses or
 * releases a button, and it yields to any execution: a scheduled move aborts the bout and the
 * execution waits for it to wind down before taking the hand.
 */

import { log } from "@core/logger";
import {
	type AnticipatedReply,
	anticipateReply,
	anticipationEngageProb,
	planAnticipationHover,
	withinHover,
} from "@core/motor/anticipation";
import { ANTICIPATION, OPPONENT_EXPLORATION } from "@core/motor/constants";
import { sampleRange } from "@core/motor/geometry";
import {
	perGameProfile,
	perMoveProfile,
	profileFor,
	withMotorSpeed,
} from "@core/motor/motor-profile";
import type { OpponentExplorationCandidates } from "@core/motor/opponent-candidates";
import {
	decideOpponentTurn,
	type ExplorationSpell,
	planOpponentExploration,
} from "@core/motor/opponent-exploration";
import type { RepertoireState } from "@core/motor/repertoire";
import { plausibleStart } from "@core/motor/sampling";
import type { Rect } from "@core/motor/types";
import { createRng } from "@core/rng";
import { errorMessage } from "@core/util/errors";
import { isAbortedError, sleep } from "@core/util/scheduler";
import type { Square } from "@typedefs/game";
import { boardGeometryOf, HandController } from "../hand-controller";
import { InputCriticalWindow } from "../input-window";
import type { AttachSettle } from "./attach-settle";
import { createBackend } from "./backend";
import type { ExecutorContext } from "./context";
import { readBoardGeometry } from "./geometry";
import type { Running } from "./run-state";

/** What the explorer must know of the execution slots to stay out of their way. */
export interface ExplorerHost {
	running(): Running | null;
	hasPending(): boolean;
}

export interface ExplorationTask {
	ac: AbortController;
	done: Promise<void>;
}

export class OpponentExplorer {
	private task: ExplorationTask | null = null;
	private seed = 0;
	private repertoire: RepertoireState | undefined;
	/** Executions waiting for an aborted bout to wind down; no new bout starts meanwhile. */
	private waiting = 0;
	/** The square the hand went to hover over for an anticipated reply this turn, and its rect. */
	private hover: { square: Square; rect: Rect } | null = null;

	constructor(
		private readonly ctx: ExecutorContext,
		private readonly settle: AttachSettle,
		private readonly host: ExplorerHost
	) {}

	/** The bout in flight (possibly already aborted and winding down). */
	current(): ExplorationTask | null {
		return this.task;
	}

	isExploring(): boolean {
		return this.task !== null && !this.task.ac.signal.aborted;
	}

	abort(): void {
		this.task?.ac.abort();
	}

	/**
	 * The square of our answering piece the hand is hovering over for an anticipated reply, or
	 * null. It is read when the opponent's move arrives, and it checks itself: the hand must still
	 * be resting over that square (`withinHover`), so a hover that never arrived, or that the hand
	 * has since left, reports nothing.
	 */
	hoverSquare(): Square | null {
		const hover = this.hover;
		if (!hover) return null;
		const at = this.ctx.ownership.position(this.ctx.tabId);
		return at && withinHover(at, hover.rect) ? hover.square : null;
	}

	/** An execution started waiting for the bout to end (`endWait()` when it has). */
	beginWait(): void {
		this.waiting += 1;
	}

	endWait(): void {
		this.waiting -= 1;
	}

	/** Start cancellable free movement; the live source also supplies the position/turn gate. */
	start(source: () => OpponentExplorationCandidates | null): void {
		const x = this.ctx;
		if (x.isDisposed() || !x.isArmed()) return;
		const previous = this.task;
		if (previous && !previous.ac.signal.aborted) return;
		const ac = new AbortController();
		const task: ExplorationTask = { ac, done: Promise.resolve() };
		this.task = task;
		// A new opponent turn: last turn's hover is history even if the hand still rests there.
		this.hover = null;
		task.done = Promise.resolve()
			.then(async () => {
				if (previous) await previous.done;
				// A completed premove reports before its execution promise settles. Let its last
				// stationary rest/release finish, then resume from the actual hand endpoint.
				for (let run = this.host.running(); run && !ac.signal.aborted; run = this.host.running())
					await run.done.catch(() => null);
				if (
					ac.signal.aborted ||
					this.host.hasPending() ||
					this.waiting > 0 ||
					x.isDisposed() ||
					!x.isArmed()
				)
					return;
				await this.settle.settle(ac.signal);
				const turnSeed = this.seed++;
				const rng = createRng(`${x.config.gameSeed}:opponent:${turnSeed}`);
				// Its own stream, so a turn without a hover draws exactly what it drew before.
				const hoverRng = createRng(`${x.config.gameSeed}:anticipate:${turnSeed}`);
				const initial = source();
				if (!initial) return;
				// Rolled once per turn: some turns get no pondering at all beyond a rest (the hand
				// keeps still, with its idle tremor, where the post-drop decision left it).
				const turn = decideOpponentTurn(initial.attention, initial.policy, rng);
				// Anticipatory hover: one draw per turn, compared against the odds of whatever reply
				// the ponder's top line anticipates at each spell (lines arrive and change mid-turn).
				const anticipationDraw = hoverRng.next();
				const anticipated = (live: OpponentExplorationCandidates): AnticipatedReply | null =>
					anticipationFor(live, anticipationDraw, x.config.tcClass);
				await sleep(
					sampleRange(
						anticipated(initial)
							? ANTICIPATION.engageDelayMs
							: initial.policy?.lowTime
								? OPPONENT_EXPLORATION.lowTimeInitialRestMs
								: OPPONENT_EXPLORATION.initialRestMs,
						rng
					),
					x.scheduler,
					ac.signal
				);
				let previousTarget: Square | undefined;
				let previousSpell: ExplorationSpell | undefined;
				while (!ac.signal.aborted && !x.isDisposed() && x.isArmed() && !this.host.hasPending()) {
					if (!source()) return;
					const reply = await readBoardGeometry(x.link, x.tabId, undefined, ac.signal);
					const candidates = source();
					if (!reply || ac.signal.aborted || !candidates) return;
					const geometry = boardGeometryOf(reply);
					const cursor = x.ownership.position(x.tabId) ?? plausibleStart(geometry.boardRect, rng);
					const profile = withMotorSpeed(
						perMoveProfile(
							perGameProfile(
								profileFor(x.config.persona, x.config.tcClass, "normal"),
								createRng(`${x.config.gameSeed}:hand`)
							),
							rng
						),
						x.config.motorSpeed
					);
					const anticipation = anticipated(candidates);
					const hover = anticipation
						? planAnticipationHover(
								{
									geometry,
									profile,
									cursor,
									...(previousTarget ? { previousTarget } : {}),
									...(previousSpell ? { previousSpell } : {}),
								},
								anticipation.reply.from,
								hoverRng
							)
						: null;
					this.hover =
						hover?.rect && anticipation ? { square: anticipation.reply.from, rect: hover.rect } : null;
					const plan =
						hover ??
						planOpponentExploration(
							{
								geometry,
								profile,
								cursor,
								...candidates,
								...(previousTarget ? { previousTarget } : {}),
								...(previousSpell ? { previousSpell } : {}),
								...(this.repertoire ? { repertoireState: this.repertoire } : {}),
								quiet: !turn.ponder,
							},
							rng
						);
					const input = new InputCriticalWindow(x.now, x.scheduler, (update) =>
						x.emit("inputCritical", update)
					);
					const controller = new HandController({
						backend: createBackend(x, cursor),
						focus: x.focus,
						ownership: x.ownership,
						geometry: x.geometry,
						...(x.board ? { board: x.board } : {}),
						rng,
						now: x.now,
						scheduler: x.scheduler,
						onInputDeadline: (at) => input.approachAt(at),
						onCriticalInput: (busy) => input.setCritical(busy),
						// No execution hand event: a position transition can arrive during any await.
					});
					const lowTime = candidates.policy?.lowTime === true;
					const ownOnly = lowTime || candidates.policy?.ownOnly === true;
					const ready = candidates.attention?.armed || candidates.attention?.repertoire?.premovePending;
					try {
						await controller.explore(x.tabId, plan.actions, ac.signal, geometry.boardRect, () => {
							const live = source();
							return (
								live !== null &&
								(!live.policy?.lowTime || lowTime) &&
								(!live.policy?.ownOnly || ownOnly) &&
								(!(live.attention?.armed || live.attention?.repertoire?.premovePending) || !!ready)
							);
						});
					} catch (error) {
						// Tightening clock/tactical policy ends the old bout before its next point.
						// Parent cancellation still exits the outer loop and retains the current endpoint.
						if (isAbortedError(error) && !ac.signal.aborted) continue;
						throw error;
					} finally {
						input.close();
					}
					previousTarget = plan.lastTarget ?? undefined;
					previousSpell = plan.spell;
					// A hover is not a repertoire spell: it neither advances nor clears that state.
					if (plan.spell !== "anticipate") this.repertoire = plan.repertoireState;
				}
			})
			.catch((error: unknown) => {
				if (!ac.signal.aborted)
					log.debug("executor: opponent exploration ended", { error: errorMessage(error) });
			})
			.finally(() => {
				if (this.task === task) this.task = null;
			});
	}
}

/**
 * The reply this turn's hand pre-positions for, if any: the ponder's top line, when this turn's
 * draw falls under that kind's odds. Never while a premove or a hold is armed, because that hand
 * already has its piece.
 */
function anticipationFor(
	candidates: OpponentExplorationCandidates,
	draw: number,
	tcClass: Parameters<typeof anticipationEngageProb>[1]
): AnticipatedReply | null {
	const attention = candidates.attention;
	if (attention?.armed || attention?.repertoire?.premovePending) return null;
	const reply = anticipateReply(candidates);
	return reply && draw < anticipationEngageProb(reply.kind, tcClass) ? reply : null;
}
