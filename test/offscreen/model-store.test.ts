// test/offscreen/model-store.test.ts — Task 34: ChessMimic bands through the generalised OPFS
// store (bundled read, verified cache, corrupt copy evicted, relayed download, unknown names).
import { describe, expect, it } from "bun:test";
import type { EnginePortMessage } from "@core/constants/messages";
import {
	CHESSMIMIC_BAND_FILES,
	type ChessMimicBandFile,
	chessMimicBandFile,
	MODELS_DIR,
} from "@core/constants/models";
import { sha256Hex } from "@offscreen/asset-store";
import {
	MODEL_CHECKSUM_ERROR,
	MODEL_NAME_ERROR,
	ModelStore,
	type ModelStoreDeps,
} from "@offscreen/model-store";
import type { OpfsDirectory, OpfsFileHandle } from "@offscreen/nnue-store";
import { encodeModelChunks } from "@service/handlers/engine/model-download";

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

function setup(options: {
	files: Record<string, ChessMimicBandFile>;
	bundledData?: Record<string, Uint8Array>;
	opfs?: FakeOpfs;
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
