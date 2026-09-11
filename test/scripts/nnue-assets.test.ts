import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { encodeNnueSource, sha256Hex, writeBundledNnue } from "../../scripts/nnue-assets";

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
