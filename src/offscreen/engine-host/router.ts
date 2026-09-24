// src/offscreen/engine-host/router.ts
/**
 * Where each engine-port command goes: NNUE and band chunks to their stores, `timing` and
 * `policy` queries to their inference hosts (answering not-available when the document serves
 * none), and everything else to the engine host. The first `configure` carrying `warmTiming`
 * pre-warms the timing head's default band (Task 34); without it nothing is loaded, so a v1 user
 * pays nothing. Likewise `warmPolicy` pre-loads that Maia-3 size (2026-09-11).
 */

import type { MaiaSize } from "@core/constants/maia";
import type {
	EnginePortCommand,
	EnginePortMessage,
	ModelChunk,
	NnueChunk,
} from "@core/constants/messages";
import { CHESSMIMIC_DEFAULT_BAND } from "@core/constants/models";
import { POLICY_NOT_AVAILABLE, type PolicyInference } from "../policy-inference";
import { TIMING_NOT_AVAILABLE, type TimingInference } from "../timing-inference";
import type { EngineHost } from "./host";

/** The store operations the port router needs. */
export interface NnueStoreLike {
	handleChunk(msg: NnueChunk): void;
	abortAll(reason: string): void;
}

/** The ChessMimic band store as the router sees it (Task 34). */
export interface ModelStoreLike {
	handleChunk(msg: ModelChunk): void;
	abortAll(reason: string): void;
}

export interface RouteTargets {
	post(msg: EnginePortMessage): void;
	store: NnueStoreLike;
	/** The current engine host (it is replaced when a review port disconnects). */
	host(): EngineHost;
	modelStore: ModelStoreLike | undefined;
	timing: TimingInference | undefined;
	policy: PolicyInference | undefined;
}

export function createCommandRouter(t: RouteTargets): (cmd: EnginePortCommand) => void {
	const { post, store, modelStore, timing, policy } = t;
	/** The default band is warmed once, on the first `configure` that asks for it. */
	let preWarmed = false;
	/** The Maia size the last `configure.warmPolicy` asked for; a repeat is not warmed again. */
	let preWarmedPolicy: MaiaSize | undefined;

	/**
	 * Load and warm `CHESSMIMIC_DEFAULT_BAND` before the first move needs it. A band's session is
	 * created inside `handle()`, so without this the first query for a band waits out the whole
	 * create + warm-up (~200 ms cold) — past the head's 100 ms budget, which means the first move
	 * silently falls back to v1. Gated on the SW's `warmTiming` because it is ~200 ms of
	 * main-thread wasm work and an 18 MB session that a v1 user must not pay for.
	 */
	const preWarm = (): void => {
		if (!timing || preWarmed) return;
		preWarmed = true;
		void timing.warm(CHESSMIMIC_DEFAULT_BAND);
	};

	/**
	 * Same idea for Maia-3: `configure.warmPolicy` names the size to have resident before the
	 * first move (`MAIA.defaultSize` on connect, the target's size once it is known). One
	 * session is resident at a time, so a different size evicts the last; the same size again
	 * — every reconnect re-sends `configure` — is a no-op here as well as in the host.
	 */
	const preWarmPolicy = (size: MaiaSize): void => {
		if (!policy || preWarmedPolicy === size) return;
		preWarmedPolicy = size;
		void policy.warm(size).then(post);
	};

	return (cmd: EnginePortCommand): void => {
		if (!cmd || typeof cmd !== "object") return;
		switch (cmd.kind) {
			case "nnue-chunk":
				store.handleChunk(cmd);
				return;
			case "model-chunk":
				modelStore?.handleChunk(cmd);
				return;
			case "timing":
				if (timing) void timing.handle(cmd).then(post);
				else post({ kind: "timing-result", id: cmd.id, probs: null, error: TIMING_NOT_AVAILABLE });
				return;
			case "timing-warm":
				void timing?.warm(cmd.band);
				return;
			case "policy":
				if (policy) void policy.handle(cmd).then(post);
				else post({ kind: "policy-result", id: cmd.id, moves: null, error: POLICY_NOT_AVAILABLE });
				return;
			case "policy-warm":
				if (policy) void policy.warm(cmd.size).then(post);
				else post({ kind: "policy-status", size: null, error: POLICY_NOT_AVAILABLE });
				return;
			case "configure":
				if (cmd.warmTiming) preWarm();
				if (cmd.warmPolicy) preWarmPolicy(cmd.warmPolicy);
				t.host().handle(cmd);
				return;
			default:
				t.host().handle(cmd);
		}
	};
}
