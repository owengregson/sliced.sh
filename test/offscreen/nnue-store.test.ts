// test/offscreen/nnue-store.test.ts
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import type { EnginePortMessage, NnueChunk } from "@core/constants/messages";
import { base64ToBytes, bytesToBase64 } from "@core/util/base64";
import {
	NNUE_CHECKSUM_ERROR,
	NNUE_NAME_ERROR,
	NnueStore,
	type OpfsDirectory,
	type OpfsFileHandle,
	sha256Hex,
} from "@offscreen/nnue-store";
import { encodeNnueChunks } from "@service/handlers/engine/nnue-download";

const ROOT = "chrome-extension://test/";

function bytes(seed: number, length = 1000): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (seed * 31 + i * 7) & 0xff;
	return out;
}

async function nameFor(data: Uint8Array): Promise<string> {
	return `nn-${(await sha256Hex(data)).slice(0, 12)}.nnue`;
}

interface FakeOpfs {
	dir: OpfsDirectory;
	files: Map<string, Uint8Array>;
	removed: string[];
	reads: string[];
}

function fakeOpfs(initial: Record<string, Uint8Array> = {}): FakeOpfs {
	const files = new Map(Object.entries(initial));
	const removed: string[] = [];
	const reads: string[] = [];
	const dir: OpfsDirectory = {
		async getFileHandle(name, options) {
			if (!files.has(name) && !options?.create) throw new Error(`NotFoundError: ${name}`);
			const handle: OpfsFileHandle = {
				async getFile() {
					reads.push(name);
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
	return { dir, files, removed, reads };
}

interface Harness {
	store: NnueStore;
	requests: string[];
	progress: Array<[string, number]>;
	fetched: string[];
	opfs: FakeOpfs;
}

function setup(options: {
	bundled?: Record<string, Uint8Array>;
	opfs?: FakeOpfs | null;
	indexedDb?: IDBFactory | null;
}): Harness {
	const requests: string[] = [];
	const progress: Array<[string, number]> = [];
	const fetched: string[] = [];
	const opfs = options.opfs === undefined ? fakeOpfs() : options.opfs;
	const bundled = options.bundled ?? {};
	const store = new NnueStore({
		post: (msg: EnginePortMessage) => {
			if (msg.kind === "nnue-request") requests.push(msg.name);
		},
		fetch: async (url: string) => {
			fetched.push(url);
			const name = url.slice(url.lastIndexOf("/") + 1);
			const data = bundled[name];
			return {
				ok: data !== undefined,
				arrayBuffer: async () => (data ?? new Uint8Array()).slice().buffer,
			};
		},
		getUrl: (path) => ROOT + path,
		opfs: opfs ? async () => opfs.dir : null,
		indexedDb: options.indexedDb ?? null,
		onProgress: (name, p) => progress.push([name, p]),
		bundled: Object.keys(bundled),
	});
	return { store, requests, progress, fetched, opfs: opfs ?? fakeOpfs() };
}

/** Poll (real timers) until `cond` holds; the store's hashing is genuinely async. */
async function until(cond: () => boolean, tries = 500): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("until: condition never held");
}

function deliver(store: NnueStore, name: string, data: Uint8Array, chunkBytes = 400): void {
	for (const chunk of encodeNnueChunks(name, data, chunkBytes)) store.handleChunk(chunk);
}

describe("base64 helpers", () => {
	it("round-trips arbitrary bytes, including lengths that are not multiples of 3", () => {
		for (const len of [0, 1, 2, 3, 4, 5, 100, 70_001]) {
			const data = bytes(len, len);
			expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
		}
		expect(bytesToBase64(new TextEncoder().encode("hello"))).toBe(btoa("hello"));
	});
});

describe("NnueStore.get", () => {
	it("returns the bundled net via fetch(getURL(assets/engine/<name>)) without touching OPFS", async () => {
		const data = bytes(1);
		const h = setup({ bundled: { [LIMITS.nnueSmallName]: data } });
		expect(await h.store.get(LIMITS.nnueSmallName)).toEqual(data);
		expect(h.fetched).toEqual([`${ROOT}assets/engine/${LIMITS.nnueSmallName}`]);
		expect(h.opfs.reads).toEqual([]);
		expect(h.requests).toEqual([]);
	});

	it("returns an OPFS copy whose hash matches the name without a download", async () => {
		const data = bytes(2);
		const name = await nameFor(data);
		const h = setup({ opfs: fakeOpfs({ [name]: data }) });
		expect(await h.store.get(name)).toEqual(data);
		expect(h.opfs.reads).toEqual([name]);
		expect(h.requests).toEqual([]);
		expect(h.fetched).toEqual([]);
	});

	it("deletes an OPFS copy whose hash mismatches and requests a download", async () => {
		const good = bytes(3);
		const name = await nameFor(good);
		const h = setup({ opfs: fakeOpfs({ [name]: bytes(4) }) });
		const p = h.store.get(name);
		await until(() => h.requests.length === 1);
		expect(h.opfs.removed).toEqual([name]);
		expect(h.requests).toEqual([name]);
		deliver(h.store, name, good);
		expect(await p).toEqual(good);
		expect(h.opfs.files.get(name)).toEqual(good);
	});

	it("reassembles port chunks in order, reports progress, verifies and persists (round trip)", async () => {
		const data = bytes(5, LIMITS.nnueChunkBytes / 1024 + 17);
		const name = await nameFor(data);
		const h = setup({});
		const p = h.store.get(name);
		await until(() => h.requests.length === 1);
		expect(h.requests).toEqual([name]);
		const chunks = [...encodeNnueChunks(name, data, 1024)];
		expect(chunks).toHaveLength(5);
		for (const chunk of chunks) h.store.handleChunk(chunk);
		const got = await p;
		expect(got).toEqual(data);
		expect(await sha256Hex(got)).toStartWith(name.slice(3, 15));
		expect(h.progress).toEqual([
			[name, 0.2],
			[name, 0.4],
			[name, 0.6],
			[name, 0.8],
			[name, 1],
		]);
		expect(h.opfs.files.get(name)).toEqual(data);
		// second get is served from OPFS
		h.requests.length = 0;
		expect(await h.store.get(name)).toEqual(data);
		expect(h.requests).toEqual([]);
	});

	it("re-requests once after a checksum mismatch, then fails", async () => {
		const good = bytes(6);
		const name = await nameFor(good);
		const h = setup({});
		const p = h.store.get(name);
		await until(() => h.requests.length === 1);
		deliver(h.store, name, bytes(7));
		await until(() => h.requests.length === 2);
		expect(h.requests).toEqual([name, name]);
		deliver(h.store, name, bytes(8));
		await expect(p).rejects.toThrow(NNUE_CHECKSUM_ERROR);
		expect(h.opfs.files.has(name)).toBe(false);
	});

	it("rejects on an error chunk and on abortAll", async () => {
		const h = setup({});
		const p = h.store.get("nn-000000000000.nnue");
		await until(() => h.requests.length === 1);
		h.store.handleChunk({ kind: "nnue-chunk", name: "nn-000000000000.nnue", error: "HTTP 404" });
		await expect(p).rejects.toThrow("HTTP 404");
		const q = h.store.get("nn-111111111111.nnue");
		await until(() => h.requests.length === 2);
		h.store.abortAll("port disconnected");
		await expect(q).rejects.toThrow("port disconnected");
		expect(h.requests).toEqual(["nn-000000000000.nnue", "nn-111111111111.nnue"]);
	});

	it("shares one download between concurrent gets of the same name", async () => {
		const data = bytes(9);
		const name = await nameFor(data);
		const h = setup({});
		const a = h.store.get(name);
		const b = h.store.get(name);
		await until(() => h.requests.length === 1);
		expect(h.requests).toEqual([name]);
		deliver(h.store, name, data);
		expect(await a).toEqual(data);
		expect(await b).toEqual(data);
	});

	it("falls back to IndexedDB when OPFS is unavailable", async () => {
		const data = bytes(10);
		const name = await nameFor(data);
		const h = setup({ opfs: null, indexedDb: globalThis.indexedDB });
		const p = h.store.get(name);
		await until(() => h.requests.length === 1);
		expect(h.requests).toEqual([name]);
		deliver(h.store, name, data);
		expect(await p).toEqual(data);
		// a fresh store (fresh document) reads it back from IndexedDB
		const again = setup({ opfs: null, indexedDb: globalThis.indexedDB });
		expect(await again.store.get(name)).toEqual(data);
		expect(again.requests).toEqual([]);
		await again.store.delete(name);
		const third = setup({ opfs: null, indexedDb: globalThis.indexedDB });
		const q = third.store.get(name);
		await until(() => third.requests.length === 1);
		expect(third.requests).toEqual([name]);
		third.store.abortAll("done");
		await expect(q).rejects.toThrow("done");
	});

	it("rejects names that are not nn-<12 hex>.nnue before touching any storage", async () => {
		const h = setup({});
		await expect(h.store.get("../evil")).rejects.toThrow(NNUE_NAME_ERROR);
		await expect(h.store.get("nn-XYZ.nnue")).rejects.toThrow(NNUE_NAME_ERROR);
		expect(h.requests).toEqual([]);
		expect(h.fetched).toEqual([]);
	});

	it("ignores chunks for names nobody requested", () => {
		const h = setup({});
		const stray: NnueChunk = { kind: "nnue-chunk", name: "x", index: 0, total: 1, bytes: "AA==" };
		expect(() => h.store.handleChunk(stray)).not.toThrow();
	});
});
