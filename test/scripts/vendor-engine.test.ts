// test/scripts/vendor-engine.test.ts — NNUE hash-prefix verification + vendored asset presence
// (Task 10, §6.2 / Appendix A §5).

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BOOKS, ENGINE_DIR, ENGINE_FILES, LIMITS } from "@core/constants";
import {
	nnueHashPrefix,
	packageFiles,
	ROOT,
	readBookManifests,
	sha256Hex,
	verifyNnueHash,
} from "../../scripts/vendor-engine";

const engineDir = path.join(ROOT, ENGINE_DIR);
const netName = ENGINE_FILES.smallnet.nnue;
const net = new Uint8Array(readFileSync(path.join(engineDir, netName)));

describe("verifyNnueHash", () => {
	it("accepts the real bundled net", () => {
		expect(sha256Hex(net).startsWith(nnueHashPrefix(netName) ?? "?")).toBe(true);
		expect(verifyNnueHash(net, netName)).toBe(true);
	});

	it("rejects a tampered buffer", () => {
		const tampered = new Uint8Array(net);
		const i = tampered.length >> 1;
		tampered[i] = (tampered[i] ?? 0) ^ 0xff;
		expect(verifyNnueHash(tampered, netName)).toBe(false);
		expect(verifyNnueHash(net.subarray(0, net.length - 1), netName)).toBe(false);
	});

	it("rejects a buffer that belongs to a different net name", () => {
		expect(verifyNnueHash(net, LIMITS.nnueBigNames[0])).toBe(false);
		expect(verifyNnueHash(net, LIMITS.nnueBigNames[1])).toBe(false);
	});

	it("rejects malformed net names instead of guessing", () => {
		expect(nnueHashPrefix(netName)).toBe("4ca89e4b3abf");
		expect(nnueHashPrefix("nn-4CA89E4B3ABF.nnue")).toBeUndefined();
		expect(nnueHashPrefix("nn-4ca89e4b3ab.nnue")).toBeUndefined();
		expect(nnueHashPrefix("4ca89e4b3abf.nnue")).toBeUndefined();
		expect(verifyNnueHash(net, "nn-.nnue")).toBe(false);
	});
});

describe("ENGINE_FILES registry", () => {
	it("every smallnet and full-build file (except the on-demand nets) exists on disk", () => {
		for (const name of [...packageFiles(ENGINE_FILES), netName])
			expect(existsSync(path.join(engineDir, name))).toBe(true);
	});

	it("does not bundle the full-strength nets (they are downloaded on demand)", () => {
		for (const name of ENGINE_FILES.full.nnue)
			expect(existsSync(path.join(engineDir, name))).toBe(false);
	});

	it("net names carry their hash prefix and are only defined in LIMITS", () => {
		expect(ENGINE_FILES.smallnet.nnue).toBe(LIMITS.nnueSmallName);
		expect(ENGINE_FILES.full.nnue).toBe(LIMITS.nnueBigNames);
		for (const name of [ENGINE_FILES.smallnet.nnue, ...ENGINE_FILES.full.nnue])
			expect(nnueHashPrefix(name)).toMatch(/^[0-9a-f]{12}$/);
	});

	it("the .js and .wasm of each variant are paired", () => {
		const { smallnet, full } = ENGINE_FILES;
		const pairs: ReadonlyArray<readonly [string, string]> = [
			[smallnet.js, smallnet.wasm],
			[smallnet.relaxedJs, smallnet.relaxedWasm],
			[full.js, full.wasm],
		];
		for (const [js, wasm] of pairs) expect(wasm).toBe(js.replace(/\.js$/, ".wasm"));
	});
});

describe("docs/third-party.md books section (Task 15)", () => {
	const doc = readFileSync(path.join(ROOT, "docs", "third-party.md"), "utf8");

	it("lists both bundled Polyglot books with their current SHA-256", () => {
		for (const name of [BOOKS.gm2600, BOOKS.club]) {
			const file = path.join(ROOT, BOOKS.dir, name);
			expect(existsSync(file)).toBe(true);
			const sha = sha256Hex(new Uint8Array(readFileSync(file)));
			expect(doc).toContain(`| \`${name}\` |`);
			expect(doc).toContain(sha);
		}
		expect(doc).toContain("CC0");
		expect(doc).toContain("random64.ts");
	});

	it("each book's build manifest matches the file and the doc records its invocation", async () => {
		const books = await readBookManifests(path.join(ROOT, BOOKS.dir), [BOOKS.gm2600, BOOKS.club]);
		expect(books.map((b) => b.manifest.book)).toEqual([BOOKS.gm2600, BOOKS.club]);
		for (const { file, manifest } of books) {
			expect(manifest.sha256).toBe(file.sha256);
			expect(manifest.bytes).toBe(file.bytes);
			expect(manifest.entries * 16).toBe(file.bytes);
			expect(manifest.inputs.length).toBeGreaterThan(0);
			for (const input of manifest.inputs) expect(doc).toContain(`--input ${input}`);
			expect(doc).toContain(`--output ${BOOKS.dir}${manifest.book}`);
		}
	});
});
