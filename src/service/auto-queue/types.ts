import type { Rng } from "@core/rng";
import type { Scheduler } from "@core/util/scheduler";
import type { RematchStep } from "@service/rematch";
import type { PendingAutoQueues } from "@typedefs/storage";

export interface AutoQueueView {
	dueAt: number;
	attempts: number;
	status: "waiting" | "break" | "retrying" | "searching" | "rematch";
}

export interface AutoQueueOptions {
	/** Discovers and activates a queue control using the virtual mouse. */
	attempt(
		tabId: number,
		gameId: string | null,
		signal: AbortSignal
	): Promise<{
		status: "started" | "searching" | "not-ready" | "in-game";
	}>;
	scheduler?: Scheduler;
	now?: () => number;
	rng: Rng;
	/** A missing session/unknown settings holds; a changed game or disabled setting cancels. */
	canQueue(tabId: number, gameId: string | null): "allow" | "hold" | "cancel";
	persistence?: {
		load(): Promise<PendingAutoQueues>;
		save(records: PendingAutoQueues): Promise<void>;
	};
	onChanged?: () => void;
	/**
	 * The rematch step for titled opponents (2026-09-13); absent means the queue never rematches.
	 * `allowed` is `automation.rematchTitled` at the moment the step would run.
	 */
	rematch?: {
		step: Pick<RematchStep, "run" | "gameStarted" | "incoming">;
		allowed(tabId: number): boolean;
	};
	/**
	 * The entry moved into its session break *after* scheduling — a rematch step that was not
	 * taken while the break was due (the session releases the mouse on it, as it does when the
	 * break is scheduled directly).
	 */
	onBreak?: (tabId: number) => void;
}
