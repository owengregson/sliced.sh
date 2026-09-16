import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
	bundledAssetFilter,
	encodeNnueSource,
	sha256Hex,
	writeBundledNnue,
} from "../../scripts/nnue-assets";

const temporary: string[] = [];

afterEach(async () => {
	for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
	const dir = await mkdtemp(path.join(tmpdir(), "sliced-nnue-assets-"));
	temporary.push(dir);
	const data = new TextEncoder().encode("verified network fixture");
	const name = `nn-${sha256Hex(data).slice(0, 12)}.nnue`;
	const spec = { name, source: `${name}.gz` };
	const dist = path.join(dir, "dist");
	return { dir, dist, data, spec };
}

describe("bundledAssetFilter", () => {
	const root = "/repo/assets";
	const engineDir = `${root}/engine/`;
	const filter = bundledAssetFilter({
		sources: new Set([`${root}/engine/nn-1a298aa575a0.nnue.gz`, `${root}/models/maia3/x.part0`]),
		engineDir,
		engineFiles: new Set(["sf_19_relaxed-simd.js", "sf_19_relaxed-simd.wasm", "LICENSE"]),
	});

	it("copies ordinary files and every directory", () => {
		expect(filter(`${root}/sounds/make_move.wav`)).toBe(true);
		expect(filter(`${root}/sounds`)).toBe(true);
		expect(filter(`${root}/engine`)).toBe(true);
		expect(filter(root)).toBe(true);
	});

	it("drops Finder and Explorer droppings anywhere", () => {
		expect(filter(`${root}/.DS_Store`)).toBe(false);
		expect(filter(`${root}/models/.DS_Store`)).toBe(false);
		expect(filter(`${root}/vendor/Thumbs.db`)).toBe(false);
		expect(filter(`${root}/fonts/._Geist-Variable.woff2`)).toBe(false);
	});

	it("drops the sources the build materialises itself", () => {
		expect(filter(`${root}/engine/nn-1a298aa575a0.nnue.gz`)).toBe(false);
		expect(filter(`${root}/models/maia3/x.part0`)).toBe(false);
	});

	it("copies the engine directory by allowlist, so a stale program never ships", () => {
		expect(filter(`${root}/engine/sf_19_relaxed-simd.js`)).toBe(true);
		expect(filter(`${root}/engine/sf_19_relaxed-simd.wasm`)).toBe(true);
		expect(filter(`${root}/engine/LICENSE`)).toBe(true);
		expect(filter(`${root}/engine/sf_19.js`)).toBe(false);
		expect(filter(`${root}/engine/sf_19.wasm`)).toBe(false);
		expect(filter(`${root}/engine/nn-61e7af4bb97d.nnue`)).toBe(false); // written by writeBundledNnue
		expect(filter(`${root}/engine/nn-unknown.nnue`)).toBe(false);
	});
});

describe("packaged NNUE assets", () => {
	it("writes verified raw bytes and leaves the compressed source out of the package", async () => {
		const { dir, dist, data, spec } = await fixture();
		const packed = await encodeNnueSource(data, spec);
		expect(await encodeNnueSource(data, spec)).toEqual(packed);
		await writeFile(path.join(dir, spec.source), packed);
		await writeBundledNnue(dir, dist, [spec]);
		expect(await readdir(dist)).toEqual([spec.name]);
		expect(new Uint8Array(await readFile(path.join(dist, spec.name)))).toEqual(data);
	});

	it("refuses a missing compressed source instead of silently shipping an online dependency", async () => {
		const { dir, dist, spec } = await fixture();
		await expect(writeBundledNnue(dir, dist, [spec])).rejects.toThrow();
		expect(await readdir(dist)).toEqual([]);
	});

	it("refuses valid gzip containing bytes from the wrong network", async () => {
		const { dir, dist, spec } = await fixture();
		await writeFile(path.join(dir, spec.source), gzipSync("wrong network"));
		await expect(writeBundledNnue(dir, dist, [spec])).rejects.toThrow("NNUE checksum mismatch");
		expect(await readdir(dist)).toEqual([]);
	});

	it("verifies ordinary raw companion sources too", async () => {
		const { dir, dist, data, spec } = await fixture();
		const raw = { ...spec, source: spec.name };
		await writeFile(path.join(dir, raw.source), data);
		await writeBundledNnue(dir, dist, [raw]);
		expect(new Uint8Array(await readFile(path.join(dist, raw.name)))).toEqual(data);
		await writeFile(path.join(dir, raw.source), "tampered");
		await expect(writeBundledNnue(dir, dist, [raw])).rejects.toThrow("NNUE checksum mismatch");
	});
});
