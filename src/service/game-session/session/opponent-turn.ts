/**
 * The opponent's turn, from the moment their position is ours to watch: the ponder (§6.4), the
 * §7.4 premove decision and its Fix F entry, the scramble hold's checkpoint cadence, the
 * pre-analysis of the position we expect to face, and the hand's idle exploration meanwhile.
 */

import type { PositionSnapshot } from "@typedefs/game";
import type { SessionCore } from "./core";
import { startOpponentExploration } from "./exploration";
import type { Prediction } from "./prediction";
import type { PremoveArming } from "./premove";
import type { QueuedPremove } from "./queued-premove";
import type { ScrambleHold } from "./scramble-hold";

export interface OpponentTurnParts {
	arming: PremoveArming;
	queue: QueuedPremove;
	holds: ScrambleHold;
	prediction: Prediction;
}

export class OpponentTurn {
	constructor(
		private readonly core: SessionCore,
		private readonly parts: OpponentTurnParts
	) {}

	/** Opponent's turn: ponder (§6.4) and prepare a premove candidate (§7.4). */
	async start(snapshot: PositionSnapshot): Promise<void> {
		const core = this.core;
		this.explore();
		const ponderer = core.ponderer;
		if (!ponderer) return;
		const history = core.historyFor(snapshot.fen);
		await ponderer.start("opponent", history.fen, history.moves);
		// §4.4: starting the ponder is an await, so the switch can go off *inside* it — and
		// `stopDisabled`'s own stop then ran before this search existed, which would leave a
		// `go infinite` running with the assistant off. Stop what we just started, and search
		// nothing more for this position.
		if (!core.mayAct() || core.snapshot !== snapshot) {
			await ponderer.stop();
			return;
		}
		await this.parts.arming.arm(snapshot);
		// Selection has already made the premove probability draw. Queue a safe candidate now,
		// with the queue's own reaction delay, before optional holds can occupy the hand.
		this.parts.queue.enter(snapshot);
		if (this.parts.queue.entry === null) this.parts.holds.scheduleDecision(snapshot, 0, false);
		await this.parts.prediction.preAnalyse(snapshot, ponderer);
	}

	/** Fresh candidate bouts share the hand with moves, and are invalidated with the position. */
	explore(): void {
		const { arming, queue, holds } = this.parts;
		startOpponentExploration(this.core, {
			armedPremove: () => arming.armed,
			entered: () => queue.entry !== null,
			holding: () => holds.holding(),
		});
	}
}
