// Recompress already packed models without changing the SLM1 format or canonical ONNX bytes.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { MODEL_PACKING } from "../src/core/constants/model-packing";
import { verifyPackedModel } from "./model-packing";
import { type PackagedModel, packagedModels } from "./verify-dist";

export interface ModelPackageSaving {
	path: string;
	before: number;
	after: number;
}

/**
 * Filtered deflate avoids expensive short matches in shuffled floating-point weights. Level 4
 * measured smaller than 9 for the current Maia model. Keep the original whenever this loses;
 * a future model or a different zlib implementation must never enlarge the installed asset.
 * Both encodings restore and hash against the unchanged registry before anything is written.
 */
export function optimizePackedModel(packed: Uint8Array, bytes: number, sha256: string): Uint8Array {
	verifyPackedModel(packed, bytes, sha256);
	const encoded = gunzipSync(packed, { maxOutputLength: bytes + MODEL_PACKING.headerBytes });
	const candidate = gzipSync(encoded, { level: 4, strategy: constants.Z_FILTERED });
	if (candidate.length >= packed.length) return packed;
	verifyPackedModel(candidate, bytes, sha256);
	return candidate;
}

/** One model at a time bounds build memory; runtime decoding and inference are unchanged. */
export async function optimizeModelPackages(
	dist: string,
	models: readonly PackagedModel[] = packagedModels()
): Promise<ModelPackageSaving[]> {
	const savings: ModelPackageSaving[] = [];
	for (const model of models) {
		if (!model.packed) continue;
		if (!model.sha256) throw new Error(`${model.path}: canonical model checksum required`);
		const file = path.join(dist, model.path);
		const packed = await readFile(file);
		const optimized = optimizePackedModel(packed, model.bytes, model.sha256);
		if (optimized !== packed) {
			// A failed write stops the build and leaves the previous verified asset intact.
			const temporary = `${file}.tmp`;
			await writeFile(temporary, optimized);
			await rename(temporary, file);
		}
		savings.push({ path: model.path, before: packed.length, after: optimized.length });
	}
	return savings;
}

if (import.meta.main) {
	const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "dist"));
	console.log(JSON.stringify(await optimizeModelPackages(dist), null, 2));
}
