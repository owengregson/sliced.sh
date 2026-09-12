// test/offscreen/policy-inference.test.ts — 2026-09-11: the offscreen Maia-3 host over a fake
// onnxruntime with the real encoder/decoder (one resident session, warm-up on the start
// position, a round trip with known logits, failures that never throw across the port, the load
// cooldown, single-thread retry, dispose). 2026-09-13: one shipped size (79M), so the two cases
// that needed a *second* size — "warming another size evicts the first" and "an eviction while a
// query runs on the old size waits for the run" — have no subject any more; the release-under-a-
// running-run rule is still covered through its other trigger, dispose.
import { describe, expect, it } from "bun:test";
import { CHESS_START_FEN } from "@core/constants/chess";
import { MAIA_INPUT, type MaiaSize } from "@core/constants/maia";
import { maiaMoveIndex } from "@core/policy/maia-encoder";
import type { OrtRuntime, OrtSession, OrtTensor } from "@offscreen/ort-loader";
import {
	createPolicyInference,
	historyForQuery,
	POLICY_BAD_INPUTS,
	POLICY_DISPOSED,
	POLICY_NO_SESSION,
	type PolicyCommand,
	policyThreads,
} from "@offscreen/policy-inference";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const SIZE_INDEX: Record<MaiaSize, number> = { "79m": 0 };

interface FakeOrt {
	runtime: OrtRuntime;
	created: Uint8Array[];
	released: number[];
	runs: Array<{ size: number; feeds: Record<string, OrtTensor> }>;
	/** Logit spikes the fake session answers with: `[vocabulary index, logit]`. */
	spikes: Array<[number, number]>;
	valueLogits: number[];
	failWhileThreaded: boolean;
}

function fakeOrt(threads = 4): FakeOrt {
	const state: FakeOrt = {
		created: [],
		released: [],
		runs: [],
		spikes: [],
		valueLogits: [0, 0, 0],
		failWhileThreaded: false,
		runtime: {
			threads,
			setThreads(n) {
				state.runtime.threads = n;
			},
			async createSession(bytes) {
				const size = bytes[0] ?? -1;
				if (state.failWhileThreaded && state.runtime.threads > 1)
					throw new Error("pthreads unavailable");
				state.created.push(bytes);
				const session: OrtSession = {
					async run(feeds) {
						state.runs.push({ size, feeds });
						const move = new Float32Array(MAIA_INPUT.moveVocab);
						for (const [i, v] of state.spikes) move[i] = v;
						return {
							[MAIA_INPUT.outputs.move]: { type: "float32", data: move, dims: [1, move.length] },
							[MAIA_INPUT.outputs.value]: {
								type: "float32",
								data: Float32Array.from(state.valueLogits),
								dims: [1, 3],
							},
						};
					},
					async release() {
						state.released.push(size);
					},
				};
				return session;
			},
			tensor(type, data, dims) {
				return { type, data, dims };
			},
		},
	};
	return state;
}

/** `bytes[0]` = size index so the fake session can tell which size it is. */
function sizeBytes(size: MaiaSize): Uint8Array {
	const out = new Uint8Array(64);
	out[0] = SIZE_INDEX[size];
	return out;
}

function fakeStore(available: readonly MaiaSize[] = ["79m"]) {
	const gets: MaiaSize[] = [];
	return {
		gets,
		store: {
			async get(size: MaiaSize) {
				gets.push(size);
				if (!available.includes(size)) throw new Error(`no such model: ${size}`);
				return sizeBytes(size);
			},
		},
	};
}

function command(over: Partial<PolicyCommand["inputs"]> = {}, id = "q1"): PolicyCommand {
	return {
		kind: "policy",
		id,
		inputs: {
			size: "79m",
			fen: CHESS_START_FEN,
			historyFens: [CHESS_START_FEN],
			selfElo: 1500,
			oppoElo: 1600,
			...over,
		},
	};
}

/** The error of a failed result (`undefined` for a success), so the union needs no narrowing per line. */
function errorOf(r: { moves: unknown; error?: string }): string | undefined {
	return r.moves === null ? r.error : undefined;
}

async function until(cond: () => boolean, tries = 500): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("until: condition never held");
}

describe("createPolicyInference", () => {
	it("warm(size) loads the session, runs one warm-up on the start position and reports the size", async () => {
		const ort = fakeOrt();
		const { store, gets } = fakeStore();
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store });
		const status = await inf.warm("79m");
		expect(status).toEqual({ kind: "policy-status", size: "79m", loadMs: expect.any(Number) });
		expect(gets).toEqual(["79m"]);
		expect(ort.created).toHaveLength(1);
		expect(ort.runs).toHaveLength(1);
		const warm = ort.runs[0]?.feeds;
		expect(warm?.[MAIA_INPUT.inputs.tokens]?.dims).toEqual([
			1,
			MAIA_INPUT.squares,
			MAIA_INPUT.tokenDim,
		]);
		expect(warm?.[MAIA_INPUT.inputs.tokens]?.data).toHaveLength(
			MAIA_INPUT.squares * MAIA_INPUT.tokenDim
		);
		expect(inf.resident()).toBe("79m");
		// Warming the resident size again is free: no second load, no second warm-up, no eviction —
		// every reconnect re-sends `configure.warmPolicy`, and the session's game-start warm is forced.
		expect(await inf.warm("79m")).toEqual({ kind: "policy-status", size: "79m", loadMs: 0 });
		expect(ort.created).toHaveLength(1);
		expect(ort.runs).toHaveLength(1);
		expect(ort.released).toEqual([]);
	});
	it("a dispose while a query is running releases the session only after the run settles", async () => {
		const ort = fakeOrt();
		const gate: { finishRun: (() => void) | null } = { finishRun: null };
		const originalCreate = ort.runtime.createSession.bind(ort.runtime);
		ort.runtime.createSession = async (bytes) => {
			const session = await originalCreate(bytes);
			const run = session.run.bind(session);
			// The session's queries block until the test lets them go (the warm-up is let go at once).
			let calls = 0;
			session.run = async (feeds) => {
				if (++calls > 1)
					await new Promise<void>((resolve) => {
						gate.finishRun = resolve;
					});
				return run(feeds);
			};
			return session;
		};
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		await inf.warm("79m");
		const answer = inf.handle(command());
		await until(() => gate.finishRun !== null);
		// Releasing a wasm session under a running `run` is undefined: the release waits.
		inf.dispose();
		expect(inf.resident()).toBeNull();
		expect(ort.released).toEqual([]);
		gate.finishRun?.();
		const result = await answer;
		expect(result.moves).not.toBeNull();
		expect(result.size).toBe("79m");
		await until(() => ort.released.length > 0);
		expect(ort.released).toEqual([SIZE_INDEX["79m"]]);
	});
	it("answers a query with the decoded legal-move distribution, WDL, size and wall time", async () => {
		const ort = fakeOrt();
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		ort.spikes = [
			[maiaMoveIndex("e2e4", false), 6],
			[maiaMoveIndex("d2d4", false), 4],
			[maiaMoveIndex("e2e5", false), 30], // illegal: must be masked out however large
		];
		ort.valueLogits = [0, 0, 8];
		const r = await inf.handle(command({ selfElo: 1234, oppoElo: 2345 }));
		if (r.moves === null) throw new Error(`unexpected error: ${r.error}`);
		expect(r.id).toBe("q1");
		expect(r.size).toBe("79m");
		expect(typeof r.ms).toBe("number");
		expect(r.moves[0]?.[0]).toBe("e2e4");
		expect(r.moves[1]?.[0]).toBe("d2d4");
		expect(r.moves.some(([uci]) => uci === "e2e5")).toBe(false);
		expect(r.moves).toHaveLength(20);
		expect(r.moves.reduce((s, [, p]) => s + p, 0)).toBeCloseTo(1, 6);
		expect(r.wdl[2]).toBeGreaterThan(0.99);
		// The ratings go in raw (the model scales them), one float32 each — the Elo slider's whole
		// effect on the model is these two numbers, whatever the size.
		const feeds = ort.runs[ort.runs.length - 1]?.feeds;
		expect(feeds?.[MAIA_INPUT.inputs.selfElo]?.dims).toEqual([1]);
		expect(feeds?.[MAIA_INPUT.inputs.selfElo]?.data[0]).toBe(1234);
		expect(feeds?.[MAIA_INPUT.inputs.oppoElo]?.data[0]).toBe(2345);
		expect(feeds?.[MAIA_INPUT.inputs.tokens]?.type).toBe("float32");
	});
	it("un-mirrors a black-to-move answer into the board frame", async () => {
		const ort = fakeOrt();
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		ort.spikes = [[maiaMoveIndex("e7e5", true), 9]];
		const r = await inf.handle(command({ fen: AFTER_E4, historyFens: [CHESS_START_FEN, AFTER_E4] }));
		if (r.moves === null) throw new Error(`unexpected error: ${r.error}`);
		expect(r.moves[0]?.[0]).toBe("e7e5");
	});
	it("a query before any warm loads the session first (that query pays the load)", async () => {
		const ort = fakeOrt();
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		expect(inf.resident()).toBeNull();
		const r = await inf.handle(command());
		expect(r.moves).not.toBeNull();
		expect(r.size).toBe("79m");
		expect(ort.created).toHaveLength(1);
		expect(ort.runs).toHaveLength(2); // the warm-up, then the query
		expect(ort.released).toEqual([]);
		expect(inf.resident()).toBe("79m");
	});
	it("appends the query's fen when the history does not end in it, and keeps the last 8", () => {
		expect(historyForQuery({ fen: AFTER_E4, historyFens: [CHESS_START_FEN] })).toEqual([
			CHESS_START_FEN,
			AFTER_E4,
		]);
		expect(historyForQuery({ fen: AFTER_E4, historyFens: [] })).toEqual([AFTER_E4]);
		expect(historyForQuery({ fen: AFTER_E4, historyFens: [CHESS_START_FEN, AFTER_E4] })).toEqual([
			CHESS_START_FEN,
			AFTER_E4,
		]);
		const long = Array.from({ length: 12 }, (_, i) => `fen${i}`);
		const trimmed = historyForQuery({ fen: "fen11", historyFens: long });
		expect(trimmed).toHaveLength(MAIA_INPUT.history);
		expect(trimmed[trimmed.length - 1]).toBe("fen11");
	});
	it("answers moves: null with the error instead of throwing (store failure, bad FEN, bad inputs)", async () => {
		const ort = fakeOrt();
		const inf = createPolicyInference({
			runtime: async () => ort.runtime,
			store: fakeStore([]).store,
		});
		const missing = await inf.handle(command());
		expect(missing.moves).toBeNull();
		expect(missing.size).toBe("79m");
		expect(errorOf(missing)).toContain("no such model");
		const badFen = await inf.handle(command({ fen: "not a fen", historyFens: [] }, "q2"));
		expect(badFen.moves).toBeNull();
		expect(typeof errorOf(badFen)).toBe("string");
		const badInputs = await inf.handle(command({ selfElo: Number.NaN }, "q3"));
		expect(badInputs.moves).toBeNull();
		expect(errorOf(badInputs)).toContain(POLICY_BAD_INPUTS);
		const badSize = await inf.handle(command({ size: "huge" as MaiaSize }, "q4"));
		expect(errorOf(badSize)).toContain(POLICY_BAD_INPUTS);
		// A name that was a size until 2026-09-13 is bad input now, not a store lookup.
		const dropped = await inf.handle(command({ size: "5m" as MaiaSize }, "q5"));
		expect(errorOf(dropped)).toContain(POLICY_BAD_INPUTS);
		expect(ort.created).toHaveLength(0); // nothing above got as far as a session
	});
	it("reports a runtime that cannot initialise once, and does not re-import it per query", async () => {
		let inits = 0;
		const inf = createPolicyInference({
			runtime: async () => {
				inits++;
				throw new Error("import failed");
			},
			store: fakeStore().store,
		});
		const a = await inf.handle(command());
		const b = await inf.handle(command({}, "q2"));
		expect(a.moves).toBeNull();
		expect(errorOf(a)).toContain("import failed");
		expect(b.moves).toBeNull();
		expect(inits).toBe(1);
	});
	it("skips a size that failed to load for a doubling cooldown instead of re-reading it every move", async () => {
		const ort = fakeOrt(1);
		let clock = 0;
		let failing = true;
		const reads: number[] = [];
		const inf = createPolicyInference({
			runtime: async () => ort.runtime,
			store: {
				async get(size: MaiaSize) {
					reads.push(clock);
					if (failing) throw new Error("transient store failure");
					return sizeBytes(size);
				},
			},
			now: () => clock,
			retryAfterMs: 1_000,
			retryMaxMs: 4_000,
		});
		expect(errorOf(await inf.handle(command({}, "a")))).toContain("transient");
		expect((await inf.warm("79m")).error).toContain(POLICY_NO_SESSION);
		expect(reads).toEqual([0]);
		clock = 1_000; // due: second attempt, then the wait doubles
		expect(errorOf(await inf.handle(command({}, "b")))).toContain("transient");
		clock = 2_999;
		expect(errorOf(await inf.handle(command({}, "c")))).toContain(POLICY_NO_SESSION);
		expect(reads).toEqual([0, 1_000]);
		failing = false;
		clock = 3_000;
		const ok = await inf.handle(command({}, "d"));
		expect(ok.moves).not.toBeNull();
		expect(reads).toEqual([0, 1_000, 3_000]);
	});
	it("retries session creation single-threaded when the threaded wasm cannot start", async () => {
		const ort = fakeOrt(4);
		ort.failWhileThreaded = true;
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		const r = await inf.handle(command());
		expect(r.moves).not.toBeNull();
		expect(ort.runtime.threads).toBe(1);
		expect(ort.created).toHaveLength(1);
	});
	it("shares one session creation between concurrent queries for the same size", async () => {
		const ort = fakeOrt();
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		const [a, b] = await Promise.all([inf.handle(command({}, "a")), inf.handle(command({}, "b"))]);
		expect(a.moves).not.toBeNull();
		expect(b.moves).not.toBeNull();
		expect(ort.created).toHaveLength(1);
	});
	it("releases a session exactly once when dispose lands mid-load", async () => {
		const ort = fakeOrt(1);
		let letGo: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			letGo = r;
		});
		const inf = createPolicyInference({
			runtime: async () => ort.runtime,
			store: {
				async get(size: MaiaSize) {
					await gate;
					return sizeBytes(size);
				},
			},
		});
		const pending = inf.warm("79m");
		inf.dispose();
		letGo?.();
		await pending;
		await until(() => ort.released.length > 0);
		await new Promise((r) => setTimeout(r, 5));
		expect(ort.released).toEqual([SIZE_INDEX["79m"]]);
	});
	it("dispose releases the resident session and later queries / warms report disposed", async () => {
		const ort = fakeOrt();
		const inf = createPolicyInference({ runtime: async () => ort.runtime, store: fakeStore().store });
		await inf.handle(command());
		inf.dispose();
		expect(ort.released).toEqual([SIZE_INDEX["79m"]]);
		expect(inf.resident()).toBeNull();
		const r = await inf.handle(command({}, "after"));
		expect(r.moves).toBeNull();
		expect(errorOf(r)).toBe(POLICY_DISPOSED);
		expect(await inf.warm("79m")).toEqual({
			kind: "policy-status",
			size: null,
			error: POLICY_DISPOSED,
		});
	});
	it("policyThreads caps hardware concurrency at LIMITS.policyInferenceThreadsMax, at least 1", () => {
		expect(policyThreads(undefined)).toBe(1);
		expect(policyThreads(0)).toBe(1);
		expect(policyThreads(2)).toBe(2);
		expect(policyThreads(64)).toBe(4);
	});
});
