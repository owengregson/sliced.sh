// scripts/verify-dist/models.ts — rule 8, packaged models: every registered Maia and ChessMimic
// asset is present, restores the canonical ONNX hash, and has no raw duplicate or source part
// in the package.

// The registry reads bundler defines at module scope; this must be evaluated before it.
import "../registry-defines";

import { MAIA_DIR, MAIA_FILES, MAIA_MODEL_FILES, MAIA_SIZES } from "../../src/core/constants/maia";
import { MODEL_PACKING, packagedModelName } from "../../src/core/constants/model-packing";
import {
	CHESSMIMIC_BAND_FILES,
	CHESSMIMIC_BANDS,
	chessMimicBandFile,
	MODELS_DIR,
} from "../../src/core/constants/models";
import { verifyPackedModel } from "../model-packing";

/** Package path plus canonical ONNX metadata, before optional lossless compression. */
export interface PackagedModel {
	path: string;
	bytes: number;
	packed?: boolean;
	sha256?: string;
}

/** Every model the built extension loads from its own package. */
export function packagedModels(): PackagedModel[] {
	return [
		...MAIA_SIZES.map((size) => ({
			...MAIA_MODEL_FILES[size],
			path: MAIA_DIR + packagedModelName(MAIA_MODEL_FILES[size].file, MAIA_MODEL_FILES[size].packed),
		})),
		...CHESSMIMIC_BANDS.filter((band) => CHESSMIMIC_BAND_FILES[band].bundled).map((band) => ({
			...CHESSMIMIC_BAND_FILES[band],
			path:
				MODELS_DIR + packagedModelName(chessMimicBandFile(band), CHESSMIMIC_BAND_FILES[band].packed),
		})),
	];
}

/** `<file>.part<i>` — a slice of the repository's split, which must never ship. */
export const MODEL_PART_RE = new RegExp(
	`${MAIA_FILES.partSuffix.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}\\d+$`
);

/** Check package presence and reject unregistered model copies; `checkPackedModels` checks hashes. */
export function checkPackagedModels(
	files: readonly string[],
	sizeOf: (file: string) => number,
	models: readonly PackagedModel[]
): string[] {
	const problems: string[] = [];
	const present = new Set(files);
	const registered = new Set(models.map((m) => m.path));
	for (const model of models) {
		if (!present.has(model.path)) {
			problems.push(`${model.path} is missing from dist/ (the copy step did not join or verify it)`);
			continue;
		}
		const bytes = sizeOf(model.path);
		if (model.packed ? bytes <= 0 || bytes >= model.bytes : bytes !== model.bytes)
			problems.push(
				`${model.path} is ${bytes} bytes, the registry says ${model.bytes}${model.packed ? " before packing (packed file must be smaller)" : ""}`
			);
	}
	for (const file of files) {
		if (MODEL_PART_RE.test(file))
			problems.push(`${file}: a split source part shipped — the build must join parts, not copy them`);
		else if (
			(file.startsWith(MAIA_DIR) || file.startsWith(MODELS_DIR)) &&
			(file.endsWith(".onnx") || file.endsWith(MODEL_PACKING.suffix)) &&
			!registered.has(file)
		)
			problems.push(`${file}: a model the registry does not name shipped`);
	}
	return problems;
}

/** Verify package decoding against the canonical ONNX hashes before shipping. */
export function checkPackedModels(
	files: readonly string[],
	readBytes: (file: string) => Uint8Array,
	models: readonly PackagedModel[]
): string[] {
	const problems: string[] = [];
	for (const model of models) {
		if (!model.packed || !files.includes(model.path)) continue;
		try {
			if (!model.sha256) throw new Error("missing canonical SHA-256");
			verifyPackedModel(readBytes(model.path), model.bytes, model.sha256);
		} catch (error) {
			problems.push(`${model.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return problems;
}
