import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { unpackModelResponse } from "@offscreen/model-unpack";
import { packModel } from "../../scripts/model-packing";
import { optimizeModelPackages, optimizePackedModel } from "../../scripts/optimize-model-packages";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("lossless model recompression", () => {
	it("never grows a package and restores the exact bytes through the production decoder", async () => {
		let state = 42;
		const weights = Uint8Array.from({ length: 1024 * 1024 + 103 }, (_, i) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return i % 2 === 0 ? state >>> 24 : 48 + (state >>> 29);
		});
		for (const data of [Uint8Array.of(1, 2, 3), new Uint8Array(20000), weights]) {
			const packed = packModel(data);
			const optimized = optimizePackedModel(packed, data.length, hash(data));
			expect(optimized.length).toBeLessThanOrEqual(packed.length);
			expect(gunzipSync(optimized)).toEqual(gunzipSync(packed));
			const restored = await unpackModelResponse(
				new Response(Uint8Array.from(optimized)),
				data.length
			);
			expect(hash(restored)).toBe(hash(data));
		}
	});

	it("rejects corruption, incorrect canonical hashes and lengths before rewriting", () => {
		const data = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
		const packed = packModel(data);
		expect(() => optimizePackedModel(packed, data.length, "0".repeat(64))).toThrow("checksum");
		expect(() => optimizePackedModel(packed, data.length - 1, hash(data))).toThrow();
		expect(() => optimizePackedModel(packed.subarray(0, -4), data.length, hash(data))).toThrow();
	});

	it("touches only registered packed assets and reports actual saved bytes", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "sliced-optimize-models-"));
		roots.push(root);
		const data = new Uint8Array(50000).fill(123);
		// A valid but inefficient original guarantees that the on-disk replacement path runs.
		const packed = gzipSync(gunzipSync(packModel(data)), { level: 0 });
		await writeFile(path.join(root, "model.pack.gz"), packed);
		await writeFile(path.join(root, "other.txt"), "preserved");
		const rows = await optimizeModelPackages(root, [
			{ path: "model.pack.gz", bytes: data.length, packed: true, sha256: hash(data) },
			{ path: "absent-raw.onnx", bytes: 1, packed: false },
		]);
		expect(rows).toEqual([
			{
				path: "model.pack.gz",
				before: packed.length,
				after: (await readFile(path.join(root, "model.pack.gz"))).length,
			},
		]);
		expect(rows[0]?.after).toBeLessThan(packed.length);
		expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe("preserved");
		expect((await readdir(root)).sort()).toEqual(["model.pack.gz", "other.txt"]);
		await expect(
			optimizeModelPackages(root, [{ path: "model.pack.gz", bytes: data.length, packed: true }])
		).rejects.toThrow("checksum required");
	});
});
