import { PREMOVE } from "@core/constants/books";

/**
 * One bounded streak per game, keyed by full UCI (including the promotion). Only completed
 * gestures count; intervening ordinary moves and cancelled plans leave the streak alone.
 * A different completed premove starts a new sequence, and a correct prediction or a premove
 * that actually lands clears it. This limits queue entry, never a legal reactive reply.
 */
export class PremoveAttemptLimit {
	private move: string | null = null;
	private ignored = 0;

	canQueue(uci: string): boolean {
		return this.move !== uci || this.ignored < PREMOVE.maxIgnoredQueueAttempts;
	}

	observe(
		uci: string,
		outcome: { completedBeforeReply: boolean; predicted: boolean; landed: boolean }
	): void {
		if (outcome.landed) {
			this.reset();
			return;
		}
		if (!outcome.completedBeforeReply) return;
		if (outcome.predicted) {
			this.reset();
			return;
		}
		this.ignored = Math.min(
			PREMOVE.maxIgnoredQueueAttempts,
			this.move === uci ? this.ignored + 1 : 1
		);
		this.move = uci;
	}

	reset(): void {
		this.move = null;
		this.ignored = 0;
	}
}
