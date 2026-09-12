// test/offscreen/maia-store.test.ts — 2026-09-11: the Maia-3 model store. Every size is bundled,
// so the store has one source (the package) and one job: hand onnxruntime bytes whose length and
// full SHA-256 match the registry, or nothing. No cache, no relayed download. 2026-09-13: one size
// ships (79M); the fakes below register it under a test-sized stand-in file.
import { describe, expect, it } from "bun:test";
import { MAIA_DIR, MAIA_MODEL_FILES, MAIA_SIZES, type MaiaSize } from "@core/constants/maia";
import { packagedModelName } from "@core/constants/model-packing";
import { sha256Hex } from "@offscreen/asset-store";
import {
	MAIA_CHECKSUM_ERROR,
	MAIA_FETCH_ERROR,
	MAIA_LENGTH_ERROR,
	MAIA_SIZE_ERROR,
	MaiaStore,
	type MaiaStoreEntry,
} from "@offscreen/maia-store";
import { packModel } from "../../scripts/model-packing";

const ROOT = "chrome-extension://test/";
const FILE = "maia3-79m.onnx";

function bytes(seed: number, length = 1000): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (seed * 31 + i * 7) & 0xff;
	return out;
}

async function entryFor(data: Uint8Array, file: string): Promise<MaiaStoreEntry> {
	return { file, bytes: data.length, sha256: await sha256Hex(data) };
}

function setup(
	files: Partial<Record<MaiaSize, MaiaStoreEntry>>,
	served: Record<string, Uint8Array | "throw">
) {
	const fetched: string[] = [];
	let digests = 0;
	const store = new MaiaStore({
		fetch: async (url) => {
			fetched.push(url);
			const name = url.slice(url.lastIndexOf("/") + 1);
			const data = served[name];
			if (data === "throw") throw new Error("network down");
			return {
				ok: data !== undefined,
				arrayBuffer: async () => (data ?? new Uint8Array()).slice().buffer,
			};
		},
		getUrl: (path) => ROOT + path,
		digest: (data) => {
			digests++;
			return crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
		},
		files,
	});
	return { store, fetched, digests: () => digests };
}

describe("MaiaStore", () => {
	it("the shipped registry names one whole .onnx per size with a 64-hex hash", () => {
		const store = new MaiaStore();
		expect(MAIA_SIZES).toEqual(["79m"]);
		for (const size of MAIA_SIZES) {
			const f = MAIA_MODEL_FILES[size];
			expect(f.file.endsWith(".onnx")).toBe(true);
			expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(f.bytes).toBeGreaterThan(1_000_000);
			expect(store.path(size)).toBe(MAIA_DIR + packagedModelName(f.file, f.packed));
		}
	});
	it("reads the bundled file from MAIA_DIR and returns it once length and hash verify", async () => {
		const data = bytes(1);
		const h = setup({ "79m": await entryFor(data, FILE) }, { [FILE]: data });
		expect(await h.store.get("79m")).toEqual(data);
		expect(h.fetched).toEqual([`${ROOT}${MAIA_DIR}${FILE}`]);
		expect(h.digests()).toBe(1);
	});
	it("decodes a packed model and verifies the original ONNX hash before returning it", async () => {
		const data = bytes(8, 10_003);
		const packedFile = packagedModelName(FILE, true);
		const entry = { ...(await entryFor(data, FILE)), packed: true };
		const h = setup({ "79m": entry }, { [packedFile]: Uint8Array.from(packModel(data)) });
		expect(await h.store.get("79m")).toEqual(data);
		expect(h.fetched).toEqual([`${ROOT}${MAIA_DIR}${packedFile}`]);
		expect(h.digests()).toBe(1);
		const wrong = setup(
			{ "79m": entry },
			{ [packedFile]: Uint8Array.from(packModel(bytes(9, data.length))) }
		);
		await expect(wrong.store.get("79m")).rejects.toThrow(MAIA_CHECKSUM_ERROR);
	});
	it("rejects a file of the wrong length before hashing it", async () => {
		const data = bytes(2);
		const entry = { ...(await entryFor(data, FILE)), bytes: data.length + 1 };
		const h = setup({ "79m": entry }, { [FILE]: data });
		await expect(h.store.get("79m")).rejects.toThrow(MAIA_LENGTH_ERROR);
		expect(h.digests()).toBe(0);
	});
	it("rejects a file whose SHA-256 is not the registry's", async () => {
		const data = bytes(3);
		const entry = { ...(await entryFor(data, FILE)), sha256: await sha256Hex(bytes(4)) };
		const h = setup({ "79m": entry }, { [FILE]: data });
		await expect(h.store.get("79m")).rejects.toThrow(MAIA_CHECKSUM_ERROR);
	});
	it("reports an unreadable bundled file (missing, or the fetch throws) as not readable", async () => {
		const data = bytes(5);
		const missing = setup({ "79m": await entryFor(data, FILE) }, {});
		await expect(missing.store.get("79m")).rejects.toThrow(MAIA_FETCH_ERROR);
		const down = setup({ "79m": await entryFor(data, FILE) }, { [FILE]: "throw" });
		await expect(down.store.get("79m")).rejects.toThrow(MAIA_FETCH_ERROR);
	});
	it("rejects a size that is not registered before touching the network", async () => {
		const data = bytes(6);
		// An empty registry override: the (only) shipped size is then unknown to this store.
		const h = setup({}, { [FILE]: data });
		await expect(h.store.get("79m")).rejects.toThrow(MAIA_SIZE_ERROR);
		await expect(h.store.get("../evil" as MaiaSize)).rejects.toThrow(MAIA_SIZE_ERROR);
		// A name that was once a size (dropped 2026-09-13) is unknown even with the real registry.
		await expect(new MaiaStore().get("5m" as MaiaSize)).rejects.toThrow(MAIA_SIZE_ERROR);
		expect(h.fetched).toEqual([]);
		expect(h.store.path("79m")).toBeUndefined();
	});
	it("shares one fetch between concurrent gets for the same size, and does not cache the bytes", async () => {
		const data = bytes(7);
		const h = setup({ "79m": await entryFor(data, FILE) }, { [FILE]: data });
		const [a, b] = await Promise.all([h.store.get("79m"), h.store.get("79m")]);
		expect(a).toEqual(data);
		expect(b).toEqual(data);
		expect(h.fetched).toHaveLength(1);
		// The session holds its own copy of 156 MB; the store must not hold a second one.
		await h.store.get("79m");
		expect(h.fetched).toHaveLength(2);
	});
});
