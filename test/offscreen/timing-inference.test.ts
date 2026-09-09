// test/offscreen/timing-inference.test.ts — Task 34: the offscreen ChessMimic host over a fake
// onnxruntime (session per band, warm-up, band substitution, failures, LRU, dispose), plus the
// two fix-round-1 guards: a band whose download *hangs* must not wedge the head, and a band that
// failed once must be retried after its cooldown rather than disabled for good.
import { describe, expect, it } from "bun:test";
import type { EnginePortMessage } from "@core/constants/messages";
import { CHESSMIMIC_BANDS, chessMimicBandFile } from "@core/constants/models";
import { CHESSMIMIC_SCALERS, standardiseInputs } from "@core/timing/chessmimic-scalers";
import { encodeRecentMoves, PAD_TOKEN, tokenizeFen } from "@core/timing/chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { TimerScheduler } from "@core/util/scheduler";
import { sha256Hex } from "@offscreen/asset-store";
import { ModelStore } from "@offscreen/model-store";
import type { OrtRuntime, OrtSession, OrtTensor } from "@offscreen/ort-loader";
import {
	createTimingInference,
	TIMING_BAD_INPUTS,
	TIMING_NO_BAND,
	type TimingCommand,
} from "@offscreen/timing-inference";

const CM = TIMING_CONSTANTS.chessmimic;
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface FakeOrt {
	runtime: OrtRuntime;
	created: Uint8Array[];
	released: number[];
	runs: Array<{ band: number; feeds: Record<string, OrtTensor> }>;
	/** Bytes[0] values whose session creation must fail. */
	failCreate: Set<number>;
	failWhileThreaded: boolean;
}

function fakeOrt(threads = 4): FakeOrt {
	const state: FakeOrt = {
		created: [],
		released: [],
		runs: [],
		failCreate: new Set(),
		failWhileThreaded: false,
		runtime: {
			threads,
			setThreads(n) {
				state.runtime.threads = n;
			},
			async createSession(bytes) {
				const band = bytes[0] ?? -1;
				if (state.failCreate.has(band)) throw new Error(`create failed for ${band}`);
				if (state.failWhileThreaded && state.runtime.threads > 1)
					throw new Error("pthreads unavailable");
				state.created.push(bytes);
				const session: OrtSession = {
					async run(feeds) {
						state.runs.push({ band, feeds });
						const probs = new Float32Array(CM.nBuckets).fill(0.5 / (CM.nBuckets - 1));
						probs[band] = 0.5;
						return { probs: { type: "float32", data: probs, dims: [1, CM.nBuckets] } };
					},
					async release() {
						state.released.push(band);
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

/** `bytes[0]` = band index so the fake session can tell which band it is. */
function bandBytes(band: string): Uint8Array {
	const out = new Uint8Array(64);
	out[0] = CHESSMIMIC_BANDS.indexOf(band as (typeof CHESSMIMIC_BANDS)[number]);
	return out;
}

function fakeStore(available: readonly string[]) {
	const gets: string[] = [];
	return {
		gets,
		store: {
			async get(name: string) {
				gets.push(name);
				const band = name.replace(/\.onnx$/, "");
				if (!available.includes(band)) throw new Error(`no such model: ${name}`);
				return bandBytes(band);
			},
		},
	};
}

interface FakeScheduler extends TimerScheduler {
	advance(ms: number): void;
	count(): number;
}

function makeScheduler(): FakeScheduler {
	let nextId = 1;
	let clock = 0;
	let timers = new Map<number, { fn: () => void; at: number }>();
	return {
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.set(id, { fn, at: clock + ms });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		now: () => clock,
		advance(ms) {
			clock += ms;
			const due = [...timers].filter(([, t]) => t.at <= clock);
			timers = new Map([...timers].filter(([, t]) => t.at > clock));
			for (const [, t] of due) t.fn();
		},
		count: () => timers.size,
	};
}

async function until(cond: () => boolean, tries = 500): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("until: condition never held");
}

function command(over: Partial<TimingCommand["inputs"]> = {}, id = "q1"): TimingCommand {
	return {
		kind: "timing",
		id,
		inputs: {
			band: "1500_1600",
			moveTokens: encodeRecentMoves(["e2e4", "e7e5"]),
			fenTokens: tokenizeFen(START),
			rating: 1550,
			playerClockS: 120,
			opponentClockS: 110,
			incrementS: 0,
			...over,
		},
	};
}

describe("createTimingInference", () => {
	it("loads the band's session once, warms it up, and answers with probabilities and the band", async () => {
		const ort = fakeOrt();
		const { store, gets } = fakeStore(CHESSMIMIC_BANDS);
		const inf = createTimingInference({ runtime: async () => ort.runtime, store });
		const a = await inf.handle(command());
		expect(a.kind).toBe("timing-result");
		expect(a.id).toBe("q1");
		expect(a.band).toBe("1500_1600");
		expect(a.error).toBeUndefined();
		expect(a.probs).toHaveLength(CM.nBuckets);
		expect(a.probs?.[1]).toBeCloseTo(0.5, 6);
		expect(typeof a.ms).toBe("number");
		// warm-up run + the real run
		expect(ort.runs).toHaveLength(2);
		const b = await inf.handle(command({}, "q2"));
		expect(b.id).toBe("q2");
		expect(ort.created).toHaveLength(1);
		expect(gets).toEqual([chessMimicBandFile("1500_1600")]);
		expect(ort.runs).toHaveLength(3);
	});
	it("feeds int32 ids (moves + FEN), the clamped standardised rating and the log clocks", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		const cmd = command({ rating: 2000, playerClockS: 33, opponentClockS: 7, incrementS: 2 });
		await inf.handle(cmd);
		const feeds = ort.runs[ort.runs.length - 1]?.feeds;
		if (!feeds) throw new Error("no run");
		const ids = feeds.input_ids;
		expect(ids?.type).toBe("int32");
		expect(ids?.dims).toEqual([1, CM.recentMoves + CM.fenTokens]);
		expect(Array.from(ids?.data ?? [])).toEqual([...cmd.inputs.moveTokens, ...cmd.inputs.fenTokens]);
		const expected = standardiseInputs(cmd.inputs);
		expect(feeds.scaled_rating?.dims).toEqual([1]);
		expect(feeds.scaled_rating?.data[0]).toBeCloseTo(expected.scaledRating, 5);
		expect(feeds.clock_features?.dims).toEqual([1, 3]);
		for (let i = 0; i < 3; i++)
			expect(feeds.clock_features?.data[i]).toBeCloseTo(expected.clockFeatures[i] ?? Number.NaN, 5);
		// warm-up used pad moves + the start position + the band centre
		const warm = ort.runs[0]?.feeds.input_ids;
		expect(Array.from(warm?.data ?? []).slice(0, CM.recentMoves)).toEqual(
			new Array<number>(CM.recentMoves).fill(PAD_TOKEN)
		);
	});
	it("substitutes the nearest available band when the requested one cannot be loaded", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(["1200_1300", "1800_1900"]).store,
		});
		const r = await inf.handle(command({ band: "1500_1600", rating: 1690 }));
		expect(r.probs).not.toBeNull();
		expect(r.band).toBe("1800_1900");
		expect(r.probs?.[2]).toBeCloseTo(0.5, 6);
		// standardised with the substituted band's scalers (rating clamped into 1800–1900)
		const feeds = ort.runs[ort.runs.length - 1]?.feeds;
		expect(feeds?.scaled_rating?.data[0]).toBeCloseTo(
			standardiseInputs({
				band: "1800_1900",
				rating: 1690,
				playerClockS: 120,
				opponentClockS: 110,
				incrementS: 0,
			}).scaledRating,
			5
		);
		// the failed band is not retried on every query
		await inf.handle(command({ band: "1500_1600" }, "q2"));
		expect(ort.created).toHaveLength(1);
	});
	it("reports an error when no band can be loaded, and when the runtime cannot initialise", async () => {
		const ort = fakeOrt();
		const none = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore([]).store,
		});
		const r = await none.handle(command());
		expect(r.probs).toBeNull();
		expect(r.error).toContain(TIMING_NO_BAND);
		let inits = 0;
		const broken = createTimingInference({
			runtime: async () => {
				inits++;
				throw new Error("import failed");
			},
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		const b1 = await broken.handle(command());
		const b2 = await broken.handle(command({}, "q2"));
		expect(b1.probs).toBeNull();
		expect(b1.error).toContain("import failed");
		expect(b2.probs).toBeNull();
		expect(inits).toBe(1); // a failed runtime is not re-imported on every query
	});
	it("does not wedge on a band whose download the service worker never answers", async () => {
		// The real `ModelStore`, not a store that conveniently rejects: 1800_1900 is registered
		// but not bundled and nothing ever answers its `model-request`. The store's stall budget
		// turns the hang into a rejection, so `resolve()` falls through to the substitute instead
		// of awaiting a promise that never settles.
		const ort = fakeOrt(1);
		const sched = makeScheduler();
		const bundled = bandBytes("1500_1600");
		const onDemand = bandBytes("1800_1900");
		const requests: string[] = [];
		const store = new ModelStore({
			post: (m: EnginePortMessage) => {
				if (m.kind === "model-request") requests.push(m.name);
			},
			fetch: async (url: string) => ({
				ok: url.endsWith(chessMimicBandFile("1500_1600")),
				arrayBuffer: async () => bundled.slice().buffer,
			}),
			getUrl: (path: string) => `chrome-extension://test/${path}`,
			opfs: null,
			indexedDb: null,
			files: {
				"1500_1600": { bytes: bundled.length, sha256: await sha256Hex(bundled), bundled: true },
				"1800_1900": { bytes: onDemand.length, sha256: await sha256Hex(onDemand), bundled: false },
			},
			scheduler: sched,
			stallMs: 5_000,
		});
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store,
			scalers: {
				"1500_1600": CHESSMIMIC_SCALERS["1500_1600"],
				"1800_1900": CHESSMIMIC_SCALERS["1800_1900"],
			},
		});
		const answer = inf.handle(command({ band: "1800_1900", rating: 1850 }));
		await until(() => requests.length === 1);
		expect(requests).toEqual([chessMimicBandFile("1800_1900")]);
		sched.advance(5_000);
		const r = await answer;
		expect(r.error).toBeUndefined();
		expect(r.probs).not.toBeNull();
		expect(r.band).toBe("1500_1600");
	});
	it("retries a band after its cooldown instead of disabling it for the document's life", async () => {
		const ort = fakeOrt(1);
		let clock = 0;
		let failing = true;
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			// Only one band is registered here, so there is no substitute to hide the retry.
			scalers: { "1500_1600": CHESSMIMIC_SCALERS["1500_1600"] },
			store: {
				async get(name: string) {
					if (failing) throw new Error("transient store failure");
					return bandBytes(name.replace(/\.onnx$/, ""));
				},
			},
			now: () => clock,
			retryAfterMs: 30_000,
		});
		expect((await inf.handle(command({}, "q1"))).error).toContain(TIMING_NO_BAND);
		failing = false;
		// Still inside the cooldown: the band is skipped, so there is nothing left to try.
		clock = 29_999;
		expect((await inf.handle(command({}, "q2"))).error).toContain(TIMING_NO_BAND);
		expect(ort.created).toHaveLength(0);
		// Past it: the band is tried again and now works.
		clock = 30_001;
		const ok = await inf.handle(command({}, "q3"));
		expect(ok.error).toBeUndefined();
		expect(ok.band).toBe("1500_1600");
		expect(ort.created).toHaveLength(1);
	});
	it("backs off exponentially between retries so a broken band is not re-read every 30 s", async () => {
		const ort = fakeOrt(1);
		let clock = 0;
		const attempts: number[] = [];
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			scalers: { "1500_1600": CHESSMIMIC_SCALERS["1500_1600"] },
			store: {
				async get() {
					attempts.push(clock);
					throw new Error("permanently broken band");
				},
			},
			now: () => clock,
			retryAfterMs: 1_000,
			retryMaxMs: 4_000,
		});
		// Attempt 1 at t=0, then the waits double: 1 s, 2 s, 4 s, then the cap holds at 4 s.
		for (const t of [0, 1_000, 3_000, 7_000, 11_000]) {
			clock = t;
			expect((await inf.handle(command({}, `q${t}`))).error).toContain(TIMING_NO_BAND);
		}
		expect(attempts).toEqual([0, 1_000, 3_000, 7_000, 11_000]);
		// One tick short of each due time the band is still skipped, so no read happens.
		clock = 14_999;
		await inf.handle(command({}, "early"));
		expect(attempts).toHaveLength(5);
		clock = 15_000;
		await inf.handle(command({}, "due"));
		expect(attempts).toHaveLength(6);
	});
	it("releases a session exactly once when dispose lands mid-load", async () => {
		const ort = fakeOrt(1);
		let letGo: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			letGo = r;
		});
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			scalers: { "1500_1600": CHESSMIMIC_SCALERS["1500_1600"] },
			store: {
				async get(name: string) {
					await gate;
					return bandBytes(name.replace(/\.onnx$/, ""));
				},
			},
		});
		const pending = inf.warm("1500_1600");
		inf.dispose(); // the load is still in flight
		letGo?.();
		await pending;
		await until(() => ort.released.length > 0);
		await new Promise((r) => setTimeout(r, 5));
		expect(ort.released).toEqual([CHESSMIMIC_BANDS.indexOf("1500_1600")]);
	});
	it("retries session creation single-threaded when the threaded wasm cannot start", async () => {
		const ort = fakeOrt(4);
		ort.failWhileThreaded = true;
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		const r = await inf.handle(command());
		expect(r.probs).not.toBeNull();
		expect(ort.runtime.threads).toBe(1);
		expect(ort.created).toHaveLength(1);
	});
	it("rejects malformed inputs without touching the runtime", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		const r = await inf.handle(command({ moveTokens: [1, 2, 3] }));
		expect(r.probs).toBeNull();
		expect(r.error).toContain(TIMING_BAD_INPUTS);
		const s = await inf.handle(command({ fenTokens: [] }, "q2"));
		expect(s.error).toContain(TIMING_BAD_INPUTS);
		const t = await inf.handle(
			command({ moveTokens: [...encodeRecentMoves([]).slice(0, 11), 5000] }, "q3")
		);
		expect(t.error).toContain(TIMING_BAD_INPUTS);
		expect(ort.created).toHaveLength(0);
	});
	it("warm(band) loads and warms the session so the first query finds it", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		await inf.warm("1800_1900");
		expect(ort.created).toHaveLength(1);
		expect(ort.runs).toHaveLength(1);
		await inf.handle(command({ band: "1800_1900" }));
		expect(ort.created).toHaveLength(1);
		expect(ort.runs).toHaveLength(2);
		await inf.warm("not_a_band"); // ignored, no throw
		expect(ort.created).toHaveLength(1);
	});
	it("keeps at most maxSessions bands loaded (LRU) and releases the rest", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
			maxSessions: 2,
		});
		await inf.handle(command({ band: "1200_1300" }, "a"));
		await inf.handle(command({ band: "1500_1600" }, "b"));
		await inf.handle(command({ band: "1200_1300" }, "c")); // 1200 most recent
		await inf.handle(command({ band: "1800_1900" }, "d")); // evicts 1500
		expect(ort.released).toEqual([1]);
		await inf.handle(command({ band: "1500_1600" }, "e")); // reloads 1500, evicts 1200
		expect(ort.released).toEqual([1, 0]);
		expect(ort.created).toHaveLength(4);
	});
	it("shares one session creation between concurrent queries for the same band", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		const [a, b] = await Promise.all([inf.handle(command({}, "a")), inf.handle(command({}, "b"))]);
		expect(a.probs).not.toBeNull();
		expect(b.probs).not.toBeNull();
		expect(ort.created).toHaveLength(1);
	});
	it("dispose releases every session and later queries report not available", async () => {
		const ort = fakeOrt();
		const inf = createTimingInference({
			runtime: async () => ort.runtime,
			store: fakeStore(CHESSMIMIC_BANDS).store,
		});
		await inf.handle(command());
		inf.dispose();
		expect(ort.released).toEqual([1]);
		const r = await inf.handle(command({}, "after"));
		expect(r.probs).toBeNull();
		expect(r.error).toBeDefined();
	});
});
