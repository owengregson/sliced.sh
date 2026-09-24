/**
 * The shared native hand for the new-game, rematch and resignation controls: `NativeControlInput`
 * owns cancellation and cleanup for one control sequence per tab and hands the sequence a
 * `NativeControlGesture` (`native-control-input/gesture.ts`) that attaches, moves and clicks.
 */

import { log } from "@core/logger";
import { throwIfAborted } from "@core/util/scheduler";
import { NativeControlGesture } from "@service/native-control-input/gesture";
import type { NativeControlInputOptions } from "@service/native-control-input/types";

export {
	type ControlClick,
	type ControlRead,
	type ControlReply,
	NativeControlGesture,
} from "@service/native-control-input/gesture";
export type { NativeControlInputOptions } from "@service/native-control-input/types";

/** Owns cancellation and cleanup for one control sequence per tab. */
export class NativeControlInput {
	private readonly active = new Map<number, AbortController>();
	private disposed = false;

	constructor(private readonly options: NativeControlInputOptions) {}

	async run<T>(
		tabId: number,
		signal: AbortSignal,
		action: (gesture: NativeControlGesture) => Promise<T>
	): Promise<T | null> {
		if (this.disposed || signal.aborted || this.active.has(tabId)) return null;
		const controller = new AbortController();
		this.active.set(tabId, controller);
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		const off = this.options.link.onDisconnect((id) => {
			if (id === tabId) abort();
		});
		const gesture = new NativeControlGesture(this.options, tabId, controller.signal);
		try {
			throwIfAborted(controller.signal);
			return await action(gesture);
		} catch (error) {
			if (!controller.signal.aborted) log.debug("native control input stopped", { tabId, error });
			throw error;
		} finally {
			await gesture.dispose();
			off();
			signal.removeEventListener("abort", abort);
			this.active.delete(tabId);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const controller of this.active.values()) controller.abort();
	}
}
