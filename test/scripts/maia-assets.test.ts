// test/scripts/maia-assets.test.ts — the shipped Maia-3 policy models match the registry
// (`src/core/constants/maia.ts`), the export manifest and the repository's split layout, and
// the split/join pair the build relies on round-trips.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	MAIA_DIR,
	MAIA_FILES,
	MAIA_INPUT,
	MAIA_MODEL_FILES,
	MAIA_SIZES,
	MAIA_UPSTREAM,
} from "@core/constants/maia";
import {
	joinMaiaParts,
	maiaPartCount,
	maiaSourceFiles,
	maiaSourceNames,
	readMaiaSource,
	splitMaiaSource,
	verifyMaiaBytes,
	writeBundledMaia,
	writeMaiaSource,
} from "../../scripts/maia-assets";

const ROOT = path.resolve(import.meta.dir, "../..");
const DIR = path.join(ROOT, MAIA_DIR);

interface Manifest {
	upstream: { name: string; repo: string; commit: string; license: string };
	export: {
		script: string;
		opset: number;
		precision: string;
		torch: string;
		onnx: string;
		onnxruntime: string;
		inputs: Record<string, string>;
		outputs: Record<string, string>;
		input: Record<string, unknown>;
	};
	split: { partSuffix: string; partBytes: number };
	models: Record<
		string,
		{
			file: string;
			bytes: number;
			sha256: string;
			parts: number;
			sourceFiles: string[];
			params: number;
			dModel: number;
			heads: number;
			upstream: { repo: string; revision: string; checkpoint: string; bytes: number; sha256: string };
			fixturePositions: number;
			maxAbsProbDiffOnnxVsTorch: number;
			argmaxAgree: string;
		}
	>;
}

interface PositionsFixture {
	history: number;
	tokenDim: number;
	positions: Array<{
		fen: string;
		historyFens: string[];
		selfElo: number;
		oppoElo: number;
		tokensSet: number[];
		legal: number[];
	}>;
}

/**
 * `top` UCIs are in the model's mirrored side-to-move frame (black's `g8f6` reads `g1f3`), as
 * `move_logits` index them; the integration test un-mirrors. The `note` field says so in-file.
 */
interface ExpectedFixture {
	size: string;
	note: string;
	positions: Array<{ top: Array<[string, number]>; value: [number, number, number] }>;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

describe("Maia-3 assets on disk", () => {
	const manifest = JSON.parse(readFileSync(path.join(DIR, MAIA_FILES.manifest), "utf8")) as Manifest;

	it("ships exactly one size — the 79M model — since 2026-09-13, and the manifest names no other", () => {
		expect([...MAIA_SIZES]).toEqual(["79m"]);
		expect(Object.keys(MAIA_MODEL_FILES)).toEqual(["79m"]);
		expect(Object.keys(manifest.models)).toEqual(["79m"]);
	});

	it("stores every size as the registry says — whole, or in parts that join to the registered hash", async () => {
		for (const size of MAIA_SIZES) {
			const spec = MAIA_MODEL_FILES[size];
			const names = maiaSourceNames(spec, MAIA_FILES);
			expect(names).toHaveLength(spec.parts);
			for (const name of names) expect(existsSync(path.join(DIR, name))).toBe(true);
			if (spec.parts > 1) {
				// The whole file is a build artefact and must not be committed beside its parts.
				expect(existsSync(path.join(DIR, spec.file))).toBe(false);
				for (let i = 0; i < names.length - 1; i += 1)
					expect(statSync(path.join(DIR, names[i] ?? "")).size).toBe(MAIA_FILES.partBytes);
			}
			const data = await readMaiaSource(DIR, spec, MAIA_FILES);
			expect(data.length).toBe(spec.bytes);
			expect(sha256(data)).toBe(spec.sha256);
		}
	});

	it("registers `parts` as the split the layout actually produces", () => {
		for (const size of MAIA_SIZES) {
			const spec = MAIA_MODEL_FILES[size];
			expect(spec.parts).toBe(maiaPartCount(spec.bytes, MAIA_FILES.partBytes));
			// Every stored piece stays under the Git host's 100 MB cap.
			for (const name of maiaSourceNames(spec, MAIA_FILES))
				expect(statSync(path.join(DIR, name)).size).toBeLessThan(100 * 1000 * 1000);
		}
	});

	it("models.json agrees with the registry and records the export", () => {
		expect(manifest.upstream.name).toBe(MAIA_UPSTREAM.name);
		expect(manifest.upstream.repo).toBe(MAIA_UPSTREAM.repo);
		expect(manifest.upstream.license).toBe(MAIA_UPSTREAM.license);
		expect(manifest.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.export.script).toBe("tools/data/09_export_maia3.py");
		expect(manifest.export.opset).toBe(17);
		expect(manifest.export.precision).toBe("fp16");
		expect(manifest.split).toEqual({
			partSuffix: MAIA_FILES.partSuffix,
			partBytes: MAIA_FILES.partBytes,
		});
		expect(manifest.export.inputs[MAIA_INPUT.inputs.tokens]).toBe(
			`float32 [batch, ${MAIA_INPUT.squares}, ${MAIA_INPUT.tokenDim}]`
		);
		expect(manifest.export.inputs[MAIA_INPUT.inputs.selfElo]).toBe("float32 [batch]");
		expect(manifest.export.inputs[MAIA_INPUT.inputs.oppoElo]).toBe("float32 [batch]");
		expect(manifest.export.outputs[MAIA_INPUT.outputs.move]).toBe(
			`float32 [batch, ${MAIA_INPUT.moveVocab}]`
		);
		expect(manifest.export.outputs[MAIA_INPUT.outputs.value]).toBe("float32 [batch, 3]");
		expect(manifest.export.input).toEqual({
			history: MAIA_INPUT.history,
			planes: MAIA_INPUT.planes,
			tokenDim: MAIA_INPUT.tokenDim,
			squares: MAIA_INPUT.squares,
			moveVocab: MAIA_INPUT.moveVocab,
			fromTo: MAIA_INPUT.fromTo,
			promotionPieces: [...MAIA_INPUT.promotionPieces],
			eloScale: MAIA_INPUT.eloScale,
			eloMin: MAIA_INPUT.eloMin,
			eloMax: MAIA_INPUT.eloMax,
		});
		expect(Object.keys(manifest.models).sort()).toEqual([...MAIA_SIZES].sort());
		for (const size of MAIA_SIZES) {
			const reg = MAIA_MODEL_FILES[size];
			const man = manifest.models[size];
			if (!man) throw new Error(`manifest lacks ${size}`);
			expect(man.file).toBe(reg.file);
			expect(man.bytes).toBe(reg.bytes);
			expect(man.sha256).toBe(reg.sha256);
			expect(man.parts).toBe(reg.parts);
			expect(man.sourceFiles).toEqual(maiaSourceNames(reg, MAIA_FILES));
			expect(man.params).toBe(reg.params);
			expect(man.dModel).toBe(reg.dModel);
			expect(man.heads).toBe(reg.heads);
			expect(man.upstream).toEqual(reg.upstream);
			expect(man.fixturePositions).toBe(60);
			// The export's own parity check: fp16 weights move well under 1e-3 of mass.
			expect(man.maxAbsProbDiffOnnxVsTorch).toBeLessThan(1e-3);
			expect(man.argmaxAgree).toBe("60/60");
		}
	});

	it("ships the AGPL-3.0 text next to the models, not a licence written from memory", () => {
		const text = readFileSync(path.join(DIR, MAIA_FILES.license), "utf8");
		expect(text).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
		expect(text).toContain("Version 3, 19 November 2007");
		expect(text).toContain("Remote Network Interaction");
		expect(text.length).toBeGreaterThan(30_000);
	});
});

describe("Maia-3 fixtures for the encoder and the inference host", () => {
	const fixtureDir = path.join(ROOT, "test/fixtures/maia3");
	const positions = JSON.parse(
		readFileSync(path.join(fixtureDir, "positions.json"), "utf8")
	) as PositionsFixture;

	it("positions.json carries the input layout and 60 fully-specified positions", () => {
		expect(positions.history).toBe(MAIA_INPUT.history);
		expect(positions.tokenDim).toBe(MAIA_INPUT.tokenDim);
		expect(positions.positions).toHaveLength(60);
		const dim = MAIA_INPUT.squares * MAIA_INPUT.tokenDim;
		for (const p of positions.positions) {
			expect(p.historyFens.length).toBeGreaterThan(0);
			expect(p.historyFens.length).toBeLessThanOrEqual(MAIA_INPUT.history);
			expect(p.historyFens[p.historyFens.length - 1]).toBe(p.fen);
			// Ascending, unique, in range; and every square carries exactly one piece plane per
			// history slot only where a piece stands, so the set is at most 64 × history.
			for (let i = 1; i < p.tokensSet.length; i += 1)
				expect(p.tokensSet[i] ?? 0).toBeGreaterThan(p.tokensSet[i - 1] ?? 0);
			for (const t of p.tokensSet) expect(t >= 0 && t < dim).toBe(true);
			expect(p.tokensSet.length).toBeLessThanOrEqual(MAIA_INPUT.squares * MAIA_INPUT.history);
			for (let i = 1; i < p.legal.length; i += 1)
				expect(p.legal[i] ?? 0).toBeGreaterThan(p.legal[i - 1] ?? 0);
			for (const m of p.legal) expect(m >= 0 && m < MAIA_INPUT.moveVocab).toBe(true);
			expect(p.legal.length).toBeGreaterThan(0);
		}
	});

	it("expected-<size>.json aligns with positions.json for every size", () => {
		for (const size of MAIA_SIZES) {
			const expected = JSON.parse(
				readFileSync(path.join(fixtureDir, `expected-${size}.json`), "utf8")
			) as ExpectedFixture;
			expect(expected.size).toBe(size);
			expect(expected.note).toContain("mirrored");
			expect(expected.positions).toHaveLength(positions.positions.length);
			// Row 1 is black to move after 1.d4: the mirrored frame shows black's g8f6 as g1f3.
			expect(positions.positions[1]?.fen).toContain(" b ");
			expect(expected.positions[1]?.top.map(([uci]) => uci)).toContain("g1f3");
			for (let i = 0; i < expected.positions.length; i += 1) {
				const row = expected.positions[i];
				const legal = positions.positions[i]?.legal.length ?? 0;
				if (!row) throw new Error(`expected-${size} lacks row ${i}`);
				// Top-5 of the *legal* set: a position with fewer legal moves has fewer rows.
				expect(row.top).toHaveLength(Math.min(5, legal));
				expect(row.value).toHaveLength(3);
				let previous = 1;
				for (const [uci, p] of row.top) {
					expect(uci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
					expect(p).toBeLessThanOrEqual(previous);
					previous = p;
				}
			}
		}
	});
});

describe("split / join", () => {
	const temporary: string[] = [];
	afterEach(async () => {
		for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
	});
	const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);

	it("slices consecutively at exactly partBytes with the remainder last, and joins back", () => {
		const data = bytes(25);
		const parts = splitMaiaSource(data, 10);
		expect(parts.map((p) => p.length)).toEqual([10, 10, 5]);
		expect(joinMaiaParts(parts)).toEqual(data);
		expect(splitMaiaSource(bytes(20), 10).map((p) => p.length)).toEqual([10, 10]);
		expect(splitMaiaSource(bytes(10), 10).map((p) => p.length)).toEqual([10]);
		expect(splitMaiaSource(bytes(3), 10).map((p) => p.length)).toEqual([3]);
		expect(splitMaiaSource(new Uint8Array(), 10).map((p) => p.length)).toEqual([0]);
		expect(maiaPartCount(25, 10)).toBe(3);
		expect(maiaPartCount(0, 10)).toBe(1);
		expect(() => maiaPartCount(1, 0)).toThrow();
	});

	it("names the source files from the registry's `parts`, and the exclusion set covers the whole too", () => {
		const layout = { partSuffix: ".part", partBytes: 10 };
		const whole = { file: "a.onnx", bytes: 3, sha256: "", parts: 1 };
		const split = { file: "b.onnx", bytes: 25, sha256: "", parts: 3 };
		expect(maiaSourceNames(whole, layout)).toEqual(["a.onnx"]);
		expect(maiaSourceNames(split, layout)).toEqual(["b.onnx.part0", "b.onnx.part1", "b.onnx.part2"]);
		expect(maiaSourceFiles([whole, split], layout)).toEqual([
			"a.onnx",
			"b.onnx",
			"b.onnx.part0",
			"b.onnx.part1",
			"b.onnx.part2",
		]);
	});

	it("round-trips a split model through the source tree into a verified whole in dist/", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "sliced-maia-assets-"));
		temporary.push(dir);
		const layout = { partSuffix: ".part", partBytes: 10 };
		const data = bytes(25);
		const spec = { file: "m.onnx", bytes: 25, sha256: sha256(data), parts: 3 };
		const src = path.join(dir, "src");
		const dist = path.join(dir, "dist");
		expect(await writeMaiaSource(src, spec, layout, data)).toEqual([
			"m.onnx.part0",
			"m.onnx.part1",
			"m.onnx.part2",
		]);
		expect((await readdir(src)).sort()).toEqual(["m.onnx.part0", "m.onnx.part1", "m.onnx.part2"]);
		await writeBundledMaia(src, dist, [spec], layout);
		expect(await readdir(dist)).toEqual(["m.onnx"]);
		expect(Buffer.from(await readFile(path.join(dist, "m.onnx"))).equals(data)).toBe(true);
		const packedDist = path.join(dir, "packed");
		await writeBundledMaia(src, packedDist, [{ ...spec, packed: true }], layout);
		expect(await readdir(packedDist)).toEqual(["m.onnx.pack.gz"]);
	});

	it("refuses a tampered part, a re-split at another size, and a mismatched registry entry", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "sliced-maia-assets-"));
		temporary.push(dir);
		const layout = { partSuffix: ".part", partBytes: 10 };
		const data = bytes(25);
		const spec = { file: "m.onnx", bytes: 25, sha256: sha256(data), parts: 3 };
		await writeMaiaSource(dir, spec, layout, data);

		await writeFile(
			path.join(dir, "m.onnx.part1"),
			Uint8Array.from(bytes(10), (b) => b ^ 1)
		);
		await expect(readMaiaSource(dir, spec, layout)).rejects.toThrow(/sha256 .* != registry/);

		await writeMaiaSource(dir, spec, layout, data);
		await writeFile(path.join(dir, "m.onnx.part0"), data.subarray(0, 9));
		await expect(readMaiaSource(dir, spec, layout)).rejects.toThrow(/every part but the last/);

		expect(() => verifyMaiaBytes(data, { ...spec, bytes: 24 })).toThrow(/24/);
		expect(() => verifyMaiaBytes(data, { ...spec, sha256: "0".repeat(64) })).toThrow(/sha256/);
		await expect(writeMaiaSource(dir, { ...spec, parts: 2 }, layout, data)).rejects.toThrow(
			/registry says 2/
		);
		await expect(writeMaiaSource(dir, spec, layout, data.subarray(1))).rejects.toThrow(/24 bytes/);
	});
});
