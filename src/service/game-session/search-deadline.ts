import { SEARCH_BUDGET } from "@core/constants/search";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import { log } from "@core/logger";

export interface SearchDeadlineOptions {
	/** Absolute wall-clock deadline, including any time spent waiting in the engine queue. */
	deadlineMs?: number;
	now?: () => number;
	signal?: AbortSignal;
}

function coherentFrame(frame: AnalysisUpdate, id: string): boolean {
	const roots = new Set<string>();
	return (
		frame.id === id &&
		frame.complete &&
		frame.lines.length > 0 &&
		frame.lines.every((line, index) => {
			const root = line.pvUci[0];
			if (
				root === undefined ||
				roots.has(root) ||
				line.multipv !== index + 1 ||
				line.depth !== frame.depth ||
				line.bound !== undefined ||
				(!Number.isFinite(line.score.cp) && !Number.isFinite(line.score.mate))
			)
				return false;
			roots.add(root);
			return true;
		})
	);
}

/** Stop a queued or running search on time; a stalled stop receipt cannot block the turn. */
export function searchResultBeforeDeadline(
	handle: AnalysisHandle,
	request: AnalysisRequest,
	options: SearchDeadlineOptions = {}
): Promise<AnalysisResult | null> {
	const { signal, deadlineMs } = options;
	const now = options.now ?? Date.now;
	return new Promise((resolve) => {
		let finished = false;
		let stopping = false;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let receiptTimer: ReturnType<typeof setTimeout> | undefined;
		let latest: AnalysisUpdate | null = null;
		let stopObserving: () => void = () => {};
		const observationEnded = new Promise<undefined>((done) => {
			stopObserving = () => done(undefined);
		});
		const finish = (result: AnalysisResult | null): void => {
			if (finished) return;
			finished = true;
			clearTimeout(deadlineTimer);
			clearTimeout(receiptTimer);
			signal?.removeEventListener("abort", onAbort);
			stopObserving();
			resolve(result);
		};
		const stop = (): void => {
			if (stopping) return;
			stopping = true;
			try {
				void handle.stop().catch((error: unknown) => log.debug("search deadline: stop failed", error));
			} catch (error) {
				log.debug("search deadline: stop refused", error);
			}
		};
		const onAbort = (): void => {
			stop();
			finish(null);
		};
		const onDeadline = (): void => {
			if (finished) return;
			stop();
			if (finished) return;
			receiptTimer = setTimeout(() => {
				// A rating-limited search needs its native bestmove; choosing its top PV strengthens it.
				if (latest === null || request.elo !== undefined) return finish(null);
				finish({
					id: request.id,
					request,
					bestmove: null,
					status: "superseded",
					final: { ...latest, complete: false },
				});
			}, SEARCH_BUDGET.stopReceiptMs);
		};
		handle.result.then(
			(result) => finish(result.status === "failed" ? null : result),
			(error: unknown) => {
				log.debug("search deadline: result failed", error);
				finish(null);
			}
		);
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (deadlineMs !== undefined) {
			const remaining = deadlineMs - now();
			if (remaining <= 0) onDeadline();
			else deadlineTimer = setTimeout(onDeadline, remaining);
		}
		void (async () => {
			const iterator = handle.updates[Symbol.asyncIterator]();
			try {
				while (!finished) {
					const next = await Promise.race([iterator.next(), observationEnded]);
					if (finished || next === undefined || next.done) break;
					if (coherentFrame(next.value, handle.id)) latest = structuredClone(next.value);
				}
			} catch (error) {
				log.debug("search deadline: updates failed", error);
			} finally {
				try {
					void Promise.resolve(iterator.return?.()).catch(() => {});
				} catch {
					// Some transports cannot close an iterator while its pending read is being cancelled.
				}
			}
		})().catch((error: unknown) => log.debug("search deadline: update stream refused", error));
	});
}
