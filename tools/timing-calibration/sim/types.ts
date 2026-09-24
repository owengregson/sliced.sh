/**
 * tools/timing-calibration/sim/types.ts — the replay's options and its per-row result.
 */

import type { TimingCalibrationTable } from "@core/constants/timing-calibration";

export interface SimOptions {
	table: TimingCalibrationTable;
	/** The session's fast-reply search cap (book answer / obvious recapture). */
	fastReply: boolean;
	/** The idle hand's anticipatory hover (and the timing model's prepared touch). */
	hover: boolean;
	chains: number;
	seed: string;
	/**
	 * Closed loop: the bot plays on its **own** clock (base, minus its recorded thinks, plus the
	 * increment) instead of the human's, and a chain that runs out stops (`onFlag`). The head's
	 * cached distribution stays the one conditioned on the human's clock; the budget, the caps and
	 * the clock policies see the bot's.
	 */
	ownClock?: boolean;
	onFlag?: (sideKey: string, chain: number, ply: number) => void;
	/** Closed loop: the bot's clock after each of its moves. */
	onClock?: (sideKey: string, chain: number, ply: number, clockMs: number, thinkMs: number) => void;
}

export type BotPath = "queued" | "fire" | "plan";

export interface SimRowResult {
	id: string;
	/** Recorded think per chain (ms). */
	bot: number[];
	path: BotPath[];
}
