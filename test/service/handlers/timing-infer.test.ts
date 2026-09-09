// test/service/handlers/timing-infer.test.ts — Task 34: the service-worker side of the timing
// port (`createTimingInferPort` correlates `timing` → `timing-result`, and expires a query the
// host never answers so the pending map cannot grow one closure per move) and the on-demand band
// relay (`attachModelDownload`).
import { describe, expect, it } from "bun:test";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { URLS } from "@core/constants/urls";
import type { ChessMimicInputs } from "@core/timing/chessmimic-head";
import { base64ToBytes } from "@core/util/base64";
import type { TimerScheduler } from "@core/util/scheduler";
import { attachModelDownload, encodeModelChunks } from "@service/handlers/engine/model-download";
import { createTimingInferPort } from "@service/handlers/engine/timing-infer";

function fakePort() {
	const posted: EnginePortCommand[] = [];
	const listeners = new Set<(m: EnginePortMessage) => void>();
	return {
		posted,
		post(cmd: EnginePortCommand) {
			posted.push(cmd);
		},
		onMessage(cb: (m: EnginePortMessage) => void) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		emit(m: EnginePortMessage) {
			for (const l of [...listeners]) l(m);
		},
		listeners,
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

const inputs: ChessMimicInputs = {
	band: "1500_1600",
	moveTokens: new Array<number>(12).fill(32),
	fenTokens: new Array<number>(78).fill(30),
	rating: 1550,
	playerClockS: 120,
	opponentClockS: 120,
	incrementS: 0,
};

describe("createTimingInferPort", () => {
	it("posts a timing command with a unique id and resolves with the matching result", async () => {
		const port = fakePort();
		const client = createTimingInferPort(port);
		const p1 = client.infer(inputs);
		const p2 = client.infer({ ...inputs, band: "1800_1900" });
		expect(port.posted).toHaveLength(2);
		const [c1, c2] = port.posted;
		if (c1?.kind !== "timing" || c2?.kind !== "timing") throw new Error("expected timing commands");
		expect(c1.id).not.toBe(c2.id);
		expect(c1.inputs).toEqual(inputs);
		const probs = new Array<number>(30).fill(1 / 30);
		port.emit({ kind: "timing-result", id: c2.id, probs, band: "1800_1900", ms: 31 });
		port.emit({ kind: "timing-result", id: "unknown", probs, band: "1500_1600" });
		port.emit({ kind: "timing-result", id: c1.id, probs, band: "1500_1600", ms: 30 });
		expect(await p1).toEqual({ probs, band: "1500_1600", ms: 30 });
		expect(await p2).toEqual({ probs, band: "1800_1900", ms: 31 });
	});
	it("resolves null on an error result (the head falls back to v1)", async () => {
		const port = fakePort();
		const client = createTimingInferPort(port);
		const p = client.infer(inputs);
		const c = port.posted[0];
		if (c?.kind !== "timing") throw new Error("expected timing command");
		port.emit({ kind: "timing-result", id: c.id, probs: null, error: "not-available" });
		expect(await p).toBeNull();
	});
	it("expires a query the host never answers, so pending never grows past the queries in flight", async () => {
		const port = fakePort();
		const sched = makeScheduler();
		const client = createTimingInferPort(port, { scheduler: sched, budgetMs: 100 });
		// Ten moves' worth of queries the offscreen document never answers (a wedged band, a
		// disposed document). Before the expiry each one left a closure behind for good.
		const answers = Array.from({ length: 10 }, () => client.infer(inputs));
		expect(client.pendingCount()).toBe(10);
		sched.advance(100);
		expect(await Promise.all(answers)).toEqual(new Array<null>(10).fill(null));
		expect(client.pendingCount()).toBe(0);
		expect(sched.count()).toBe(0);
	});
	it("a query answered inside the budget clears its expiry and keeps its result", async () => {
		const port = fakePort();
		const sched = makeScheduler();
		const client = createTimingInferPort(port, { scheduler: sched, budgetMs: 100 });
		const p = client.infer(inputs);
		const c = port.posted[0];
		if (c?.kind !== "timing") throw new Error("expected timing command");
		const probs = new Array<number>(30).fill(1 / 30);
		port.emit({ kind: "timing-result", id: c.id, probs, band: "1500_1600", ms: 30 });
		expect(await p).toEqual({ probs, band: "1500_1600", ms: 30 });
		expect(client.pendingCount()).toBe(0);
		expect(sched.count()).toBe(0);
		// A late duplicate for an id nobody waits on is ignored rather than throwing.
		port.emit({ kind: "timing-result", id: c.id, probs, band: "1500_1600" });
		sched.advance(1_000);
		expect(client.pendingCount()).toBe(0);
	});
	it("warm posts timing-warm and dispose settles pending queries with null and stops listening", async () => {
		const port = fakePort();
		const client = createTimingInferPort(port);
		client.warm("1200_1300");
		expect(port.posted).toEqual([{ kind: "timing-warm", band: "1200_1300" }]);
		const p = client.infer(inputs);
		client.dispose();
		expect(await p).toBeNull();
		expect(port.listeners.size).toBe(0);
		expect(client.pendingCount()).toBe(0);
	});
});

describe("attachModelDownload", () => {
	it("fetches a registered band from URLS.chessmimicBandBase and streams model-chunks back", async () => {
		const port = fakePort();
		const data = new Uint8Array(1500).map((_, i) => i & 0xff);
		const urls: string[] = [];
		const detach = attachModelDownload(port, {
			fetch: async (url) => {
				urls.push(url);
				return { ok: true, status: 200, arrayBuffer: async () => data.slice().buffer };
			},
			chunkBytes: 1000,
		});
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		expect(urls).toEqual([`${URLS.chessmimicBandBase}1000_1100.onnx`]);
		expect(port.posted).toHaveLength(2);
		const [a, b] = port.posted;
		if (a?.kind !== "model-chunk" || b?.kind !== "model-chunk" || !("bytes" in a) || !("bytes" in b))
			throw new Error("expected data chunks");
		expect([a.index, a.total, b.index, b.total]).toEqual([0, 2, 1, 2]);
		const joined = new Uint8Array([...base64ToBytes(a.bytes), ...base64ToBytes(b.bytes)]);
		expect(joined).toEqual(data);
		expect([...encodeModelChunks("x.onnx", data, 1000)]).toHaveLength(2);
		detach();
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		expect(urls).toHaveLength(1);
	});
	it("posts each chunk while the body is still streaming, not after it has all arrived", async () => {
		// The property the offscreen store's per-chunk stall budget depends on: if the relay
		// buffered `arrayBuffer()` first, nothing would be posted until `done`, and that budget
		// would silently bound the whole fetch instead of the gap between chunks.
		const port = fakePort();
		const pieces = [
			new Uint8Array(1000).fill(1),
			new Uint8Array(1000).fill(2),
			new Uint8Array(1000).fill(3),
		];
		/** Chunks posted at the moment each `read()` was served. */
		const postedAtRead: number[] = [];
		let i = 0;
		attachModelDownload(port, {
			chunkBytes: 1000,
			fetch: async () => ({
				ok: true,
				status: 200,
				headers: { get: (h) => (h.toLowerCase() === "content-length" ? "3000" : null) },
				body: {
					getReader: () => ({
						read: async () => {
							postedAtRead.push(port.posted.length);
							return i < pieces.length ? { done: false, value: pieces[i++] } : { done: true };
						},
					}),
				},
				arrayBuffer: async () => {
					throw new Error("the relay must stream, not buffer");
				},
			}),
		});
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		// Four reads (three pieces + the `done`); by the last one, chunks are already out.
		expect(postedAtRead).toEqual([0, 0, 1, 2]);
		const chunks = port.posted.filter(
			(c): c is Extract<EnginePortCommand, { kind: "model-chunk" }> => c.kind === "model-chunk"
		);
		expect(chunks).toHaveLength(3);
		const joined: number[] = [];
		for (const c of chunks) {
			if (!("bytes" in c)) throw new Error("expected data chunks");
			joined.push(...base64ToBytes(c.bytes));
			// Content-Length was present, so every chunk carries the exact total (real progress).
			expect(c.total).toBe(3);
		}
		const all: number[] = [];
		for (const piece of pieces) all.push(...piece);
		expect(new Uint8Array(joined)).toEqual(new Uint8Array(all));
	});
	it("keeps the store from completing early when the server sends no Content-Length", async () => {
		const port = fakePort();
		const pieces = [new Uint8Array(1000).fill(7), new Uint8Array(500).fill(8)];
		let i = 0;
		attachModelDownload(port, {
			chunkBytes: 1000,
			fetch: async () => ({
				ok: true,
				status: 200,
				headers: { get: () => null },
				body: {
					getReader: () => ({
						read: async () => (i < pieces.length ? { done: false, value: pieces[i++] } : { done: true }),
					}),
				},
				arrayBuffer: async () => {
					throw new Error("the relay must stream, not buffer");
				},
			}),
		});
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		const chunks = port.posted.filter(
			(c): c is Extract<EnginePortCommand, { kind: "model-chunk" }> => c.kind === "model-chunk"
		);
		expect(chunks).toHaveLength(2);
		// Non-final chunk advertises one more than has arrived, so `received < total` holds; the
		// final chunk carries the true count and completes the download.
		expect(chunks.map((c) => ("total" in c ? c.total : -1))).toEqual([2, 2]);
	});
	it("reports an HTTP failure as an error chunk", async () => {
		const port = fakePort();
		attachModelDownload(port, {
			fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
		});
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		expect(port.posted).toEqual([{ kind: "model-chunk", name: "1000_1100.onnx", error: "HTTP 404" }]);
	});
});
