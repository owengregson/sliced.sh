// test/offscreen/model-store.test.ts — Task 34: ChessMimic bands through the generalised OPFS
// store (bundled read, verified cache, corrupt copy evicted, relayed download, the stall budget
// that stops a service worker which never answers from wedging a band, unknown names).
import { describe, expect, it } from "bun:test";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import {
	CHESSMIMIC_BAND_FILES,
	type ChessMimicBandFile,
	chessMimicBandFile,
	MODELS_DIR,
} from "@core/constants/models";
import type { TimerScheduler } from "@core/util/scheduler";
import { ASSET_DOWNLOAD_STALLED, ASSET_DOWNLOAD_TOO_LONG, sha256Hex } from "@offscreen/asset-store";
import {
	MODEL_CHECKSUM_ERROR,
	MODEL_NAME_ERROR,
	ModelStore,
	type ModelStoreDeps,
} from "@offscreen/model-store";
import type { OpfsDirectory, OpfsFileHandle } from "@offscreen/nnue-store";
import { attachModelDownload, encodeModelChunks } from "@service/handlers/engine/model-download";

const ROOT = "chrome-extension://test/";

function bytes(seed: number, length = 1000): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (seed * 31 + i * 7) & 0xff;
	return out;
}

interface FakeOpfs {
	dir: OpfsDirectory;
	files: Map<string, Uint8Array>;
	removed: string[];
}

function fakeOpfs(initial: Record<string, Uint8Array> = {}): FakeOpfs {
	const files = new Map(Object.entries(initial));
	const removed: string[] = [];
	const dir: OpfsDirectory = {
		async getFileHandle(name, options) {
			if (!files.has(name) && !options?.create) throw new Error(`NotFoundError: ${name}`);
			const handle: OpfsFileHandle = {
				async getFile() {
					const data = files.get(name);
					if (!data) throw new Error(`NotFoundError: ${name}`);
					return { arrayBuffer: async () => data.slice().buffer };
				},
				async createWritable() {
					let pending: Uint8Array | undefined;
					return {
						async write(data: Uint8Array) {
							pending = data.slice();
						},
						async close() {
							if (pending) files.set(name, pending);
						},
					};
				},
			};
			return handle;
		},
		async removeEntry(name) {
			removed.push(name);
			files.delete(name);
		},
	};
	return { dir, files, removed };
}

async function registryFor(
	entries: Record<string, { data: Uint8Array; bundled: boolean }>
): Promise<Record<string, ChessMimicBandFile>> {
	const out: Record<string, ChessMimicBandFile> = {};
	for (const [band, e] of Object.entries(entries))
		out[band] = { bytes: e.data.length, sha256: await sha256Hex(e.data), bundled: e.bundled };
	return out;
}

interface FakeScheduler extends TimerScheduler {
	/** Move the clock forward and run every timer that comes due. */
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

function setup(options: {
	files: Record<string, ChessMimicBandFile>;
	bundledData?: Record<string, Uint8Array>;
	opfs?: FakeOpfs;
	scheduler?: TimerScheduler;
	stallMs?: number;
	totalMs?: number;
}) {
	const requests: string[] = [];
	const fetched: string[] = [];
	const opfs = options.opfs ?? fakeOpfs();
	const bundledData = options.bundledData ?? {};
	const deps: ModelStoreDeps = {
		post: (msg: EnginePortMessage) => {
			if (msg.kind === "model-request") requests.push(msg.name);
		},
		fetch: async (url: string) => {
			fetched.push(url);
			const name = url.slice(url.lastIndexOf("/") + 1);
			const data = bundledData[name];
			return {
				ok: data !== undefined,
				arrayBuffer: async () => (data ?? new Uint8Array()).slice().buffer,
			};
		},
		getUrl: (path) => ROOT + path,
		opfs: async () => opfs.dir,
		indexedDb: null,
		files: options.files,
		...(options.scheduler ? { scheduler: options.scheduler } : {}),
		...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
		...(options.totalMs === undefined ? {} : { totalMs: options.totalMs }),
	};
	return { store: new ModelStore(deps), requests, fetched, opfs };
}

async function until(cond: () => boolean, tries = 500): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("until: condition never held");
}

describe("ModelStore", () => {
	it("the shipped registry names the three bundled bands with 64-hex hashes", () => {
		for (const [band, f] of Object.entries(CHESSMIMIC_BAND_FILES)) {
			expect(f.bundled).toBe(true);
			expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(f.bytes).toBeGreaterThan(1_000_000);
			expect(chessMimicBandFile(band)).toBe(`${band}.onnx`);
		}
	});
	it("reads a bundled band from the package (assets/models/chessmimic/<band>.onnx), no OPFS", async () => {
		const data = bytes(1);
		const files = await registryFor({ "1500_1600": { data, bundled: true } });
		const h = setup({ files, bundledData: { "1500_1600.onnx": data } });
		expect(await h.store.get("1500_1600.onnx")).toEqual(data);
		expect(h.fetched).toEqual([`${ROOT}${MODELS_DIR}1500_1600.onnx`]);
		expect(h.requests).toEqual([]);
	});
	it("returns a verified OPFS copy of an on-demand band without downloading", async () => {
		const data = bytes(2);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const h = setup({ files, opfs: fakeOpfs({ "1000_1100.onnx": data }) });
		expect(await h.store.get("1000_1100.onnx")).toEqual(data);
		expect(h.requests).toEqual([]);
		expect(h.fetched).toEqual([]);
	});
	it("evicts a corrupt cached copy, requests a download, reassembles chunks, verifies and persists", async () => {
		const data = bytes(3, 2500);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const h = setup({ files, opfs: fakeOpfs({ "1000_1100.onnx": bytes(99, 2500) }) });
		const p = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 1);
		expect(h.opfs.removed).toEqual(["1000_1100.onnx"]);
		for (const chunk of encodeModelChunks("1000_1100.onnx", data, 1000)) h.store.handleChunk(chunk);
		expect(await p).toEqual(data);
		expect(h.opfs.files.get("1000_1100.onnx")).toEqual(data);
	});
	it("re-requests once after a checksum mismatch, then fails", async () => {
		const data = bytes(4, 800);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const h = setup({ files });
		const p = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 1);
		for (const c of encodeModelChunks("1000_1100.onnx", bytes(5, 800), 400)) h.store.handleChunk(c);
		await until(() => h.requests.length === 2);
		for (const c of encodeModelChunks("1000_1100.onnx", bytes(6, 800), 400)) h.store.handleChunk(c);
		await expect(p).rejects.toThrow(MODEL_CHECKSUM_ERROR);
	});
	it("rejects an error chunk and aborted downloads", async () => {
		const data = bytes(7);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const h = setup({ files });
		const p = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 1);
		h.store.handleChunk({ kind: "model-chunk", name: "1000_1100.onnx", error: "HTTP 404" });
		await expect(p).rejects.toThrow("HTTP 404");
		const q = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 2);
		h.store.abortAll("port disconnected");
		await expect(q).rejects.toThrow("port disconnected");
	});
	it("abandons a download the service worker never answers, so the band is not wedged", async () => {
		// The failure this guards: `post` goes out, nothing ever comes back (no relay registered,
		// the SW died mid-download, the port is silently dead). Before the stall budget the
		// promise stayed pending forever and `timing-inference`'s serial `resolve()` never
		// reached the substitute band.
		const data = bytes(11, 900);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const sched = makeScheduler();
		const h = setup({ files, scheduler: sched, stallMs: 5_000 });
		const p = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 1);
		expect(sched.count()).toBe(2); // the stall budget and the whole-download backstop
		sched.advance(5_000);
		await expect(p).rejects.toThrow(ASSET_DOWNLOAD_STALLED);
		expect(sched.count()).toBe(0); // both are cleared when the download is abandoned
		// It is only a stall, so the band can be asked for again.
		const q = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 2);
		for (const c of encodeModelChunks("1000_1100.onnx", data, 400)) h.store.handleChunk(c);
		expect(await q).toEqual(data);
	});
	it("the stall budget is per chunk: the real relay's slow but progressing download finishes", async () => {
		// End to end against the actual `attachModelDownload` relay, not a hand-fed chunk
		// sequence: the source hands the relay 1 500 bytes every 4 s of (fake) clock, so the
		// transfer takes 24 s against a 5 s budget. It only passes because the relay posts each
		// slice while the body is still streaming — a relay that buffered `arrayBuffer()` first
		// would post nothing for 24 s and trip the budget.
		const data = bytes(12, 7500);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const sched = makeScheduler();
		const requests: string[] = [];
		const relayListeners = new Set<(m: EnginePortMessage) => void>();
		let store: ModelStore | undefined;
		const relayPort = {
			onMessage(cb: (m: EnginePortMessage) => void) {
				relayListeners.add(cb);
				return () => relayListeners.delete(cb);
			},
			post(cmd: EnginePortCommand) {
				if (cmd.kind === "model-chunk") store?.handleChunk(cmd);
			},
		};
		const PIECE = 1500;
		const STEP_MS = 4_000;
		let at = 0;
		let buffered = 0;
		attachModelDownload(relayPort, {
			chunkBytes: 1000,
			fetch: async () => ({
				ok: true,
				status: 200,
				headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "7500" : null) },
				body: {
					getReader: () => ({
						read: async () => {
							sched.advance(STEP_MS); // time on the wire, before anything is delivered
							if (at >= data.length) return { done: true };
							const value = data.slice(at, at + PIECE);
							at += PIECE;
							return { done: false, value };
						},
					}),
				},
				// Same bytes, same wire time, delivered only at the end — what the relay used to
				// do. Reaching this path makes the download exceed the 5 s budget and reject,
				// which is exactly the production failure this test guards against.
				arrayBuffer: async () => {
					buffered++;
					for (let sent = 0; sent < data.length; sent += PIECE) sched.advance(STEP_MS);
					sched.advance(STEP_MS);
					at = data.length;
					return data.slice().buffer;
				},
			}),
		});
		store = new ModelStore({
			post: (msg: EnginePortMessage) => {
				if (msg.kind === "model-request") requests.push(msg.name);
				for (const l of [...relayListeners]) l(msg);
			},
			fetch: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }),
			getUrl: (path) => ROOT + path,
			opfs: null,
			indexedDb: null,
			files,
			scheduler: sched,
			stallMs: 5_000,
		});
		expect(await store.get("1000_1100.onnx")).toEqual(data);
		expect(requests).toEqual(["1000_1100.onnx"]);
		expect(sched.now()).toBeGreaterThan(20_000); // far past a 5 s *total* budget
		expect(buffered).toBe(0); // the body was streamed, never buffered
		expect(sched.count()).toBe(0); // the timer is cleared when the download completes
	});
	it("only a new, non-empty chunk rearms the stall budget, and the total budget is a backstop", async () => {
		const data = bytes(13, 2000);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const sched = makeScheduler();
		const h = setup({ files, scheduler: sched, stallMs: 5_000, totalMs: 1_000_000 });
		const p = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 1);
		const [first] = [...encodeModelChunks("1000_1100.onnx", data, 1000)];
		if (!first || !("bytes" in first)) throw new Error("expected a data chunk");
		sched.advance(4_000);
		h.store.handleChunk(first); // real progress: rearms
		sched.advance(4_000);
		h.store.handleChunk(first); // the same index again: must NOT rearm
		sched.advance(1_000);
		await expect(p).rejects.toThrow(ASSET_DOWNLOAD_STALLED);
	});
	it("abandons a download that outruns the total budget even while chunks keep arriving", async () => {
		const data = bytes(14, 4000);
		const files = await registryFor({ "1000_1100": { data, bundled: false } });
		const sched = makeScheduler();
		const h = setup({ files, scheduler: sched, stallMs: 5_000, totalMs: 12_000 });
		const p = h.store.get("1000_1100.onnx");
		await until(() => h.requests.length === 1);
		const chunks = [...encodeModelChunks("1000_1100.onnx", data, 1000)];
		// Every chunk rearms the stall budget, so only the total backstop can stop this.
		for (const c of chunks.slice(0, 3)) {
			sched.advance(4_000);
			h.store.handleChunk(c);
		}
		await expect(p).rejects.toThrow(ASSET_DOWNLOAD_TOO_LONG);
		expect(sched.count()).toBe(0);
	});
	it("rejects names that are not registered bands before touching any storage", async () => {
		const files = await registryFor({ "1500_1600": { data: bytes(1), bundled: true } });
		const h = setup({ files });
		await expect(h.store.get("../evil.onnx")).rejects.toThrow(MODEL_NAME_ERROR);
		await expect(h.store.get("2000_2100.onnx")).rejects.toThrow(MODEL_NAME_ERROR);
		await expect(h.store.get("1500_1600")).rejects.toThrow(MODEL_NAME_ERROR);
		expect(h.fetched).toEqual([]);
		expect(h.requests).toEqual([]);
	});
});
