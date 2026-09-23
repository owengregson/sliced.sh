/**
 * When the move-review engine may search: never across our own foreground preparation (a pipeline
 * run, a deep move search) and never across an input-critical window the hand has announced. The
 * gates are derived from two live sets — the preparations in flight and the executors' input
 * windows — so every change is one `update()` that recomputes all three.
 */

import type { MoveExecutor } from "@service/move-executor";
import type { InputCriticalUpdate } from "@service/move-executor/input-window";
import type { BoardEffectsReporter } from "../board-effects";
import type { SessionCore } from "./core";

export class ReviewAdmission {
	private playBusy = false;
	private readonly preparations = new Set<AbortSignal>();
	private readonly inputs = new Map<object, InputCriticalUpdate & { executor: MoveExecutor }>();

	constructor(
		private readonly core: SessionCore,
		private readonly reporter: BoardEffectsReporter
	) {}

	/** Only foreground move preparation pauses independent review search. */
	private setPlayBusy(busy: boolean): void {
		if (this.playBusy === busy) return;
		this.playBusy = busy;
		if (busy) this.reporter.setPlayBusy(true);
		this.core.deps.review?.setPlayBusy?.(`tab:${this.core.tabId}`, busy);
		if (!busy) this.reporter.setPlayBusy(false);
	}

	update(): void {
		let availableUntil: number | null = null;
		let inputBusy = false;
		for (const input of this.inputs.values()) {
			inputBusy ||= input.busy;
			if (input.availableUntil !== null)
				availableUntil = Math.min(availableUntil ?? Infinity, input.availableUntil);
		}
		// Budget first: reopening either gate must not admit a job across an imminent input.
		this.reporter.setAvailableUntil(availableUntil);
		this.reporter.setInputBusy(inputBusy);
		this.setPlayBusy(this.preparations.size > 0);
	}

	/** Foreground preparation under `signal` begins; the returned release (or the abort) ends it. */
	beginPreparation(signal: AbortSignal): () => void {
		const release = (): void => {
			signal.removeEventListener("abort", release);
			if (this.preparations.delete(signal)) this.update();
		};
		if (!signal.aborted) {
			this.preparations.add(signal);
			signal.addEventListener("abort", release, { once: true });
			this.update();
		}
		return release;
	}

	onInputCritical(executor: MoveExecutor, update: InputCriticalUpdate): void {
		if (update.done) this.inputs.delete(update.token);
		else this.inputs.set(update.token, { ...update, executor });
		this.update();
	}

	/** Detached listeners cannot release their old tokens; retain protection through recovery. */
	retire(executor: MoveExecutor): void {
		void executor.whenIdle().finally(() => {
			for (const [token, input] of this.inputs)
				if (input.executor === executor) this.inputs.delete(token);
			this.update();
		});
	}
}
