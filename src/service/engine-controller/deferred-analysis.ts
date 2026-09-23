import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import { emptyResult } from "@service/analysis/handles";

/**
 * Without a network configurator, UCI owns admission after a game reset: the request waits for
 * `change`, then `launch` starts it (or declines with `null`). Stopping it first settles it
 * `superseded` without a search.
 */
export function analysisAfter(
	req: AnalysisRequest,
	change: Promise<void>,
	launch: () => AnalysisHandle | null
): AnalysisHandle {
	let cancelled = false;
	let inner: AnalysisHandle | null = null;
	let settle: (result: AnalysisResult) => void = () => {};
	const result = new Promise<AnalysisResult>((resolve) => {
		settle = resolve;
	});
	const started = change.then(
		() => {
			if (cancelled) return null;
			inner = launch();
			return inner;
		},
		() => null
	);
	void started
		.then(async (handle) => {
			settle(handle ? await handle.result : emptyResult(req, cancelled ? "superseded" : "failed"));
		})
		.catch(() => settle(emptyResult(req, "failed")));
	async function* updates(): AsyncGenerator<AnalysisUpdate> {
		const handle = await started;
		if (handle) yield* handle.updates;
	}
	return {
		id: req.id,
		updates: updates(),
		result,
		stop: async () => {
			cancelled = true;
			if (inner) await inner.stop();
			else settle(emptyResult(req, "superseded"));
		},
	};
}
