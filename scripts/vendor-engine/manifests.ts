// scripts/vendor-engine/manifests.ts — the build manifests the vendored assets carry, and the
// verified descriptions the notice is rendered from.

import type { VendoredFile } from "../lib/fs";

/** `<book>.build.json` written by `scripts/build-club-book.py` next to each game book. */
export interface BookManifest {
	book: string;
	script: string;
	inputs: string[];
	/** SHA-256 of every input (2026-09-15 on). */
	input_sha256?: Record<string, string>;
	filters: {
		min_elo: number;
		max_elo: number | null;
		max_ply: number;
		min_count_requested: number;
		min_count: number;
		/** Games reaching the position (2026-09-15 on; absent = 0). */
		min_position?: number;
		/** Share of the position's games (2026-09-15 on; absent = 0). */
		min_share?: number;
		max_bytes: number;
		max_games: number;
		keep_bullet: boolean;
		/** Games without both ratings kept (2026-09-15 on; absent = false). */
		allow_unrated?: boolean;
	};
	games_read: number;
	games_kept: number;
	positions: number;
	entries: number;
	bytes: number;
	sha256: string;
}

/** `theory.bin.build.json` written by `scripts/build-theory-book.py`. */
export interface TheoryBookManifest {
	book: string;
	kind: "theory";
	script: string;
	source: string;
	inputs: string[];
	input_sha256: Record<string, string>;
	lines: number;
	skipped_lines: number;
	max_plies: number;
	positions: number;
	entries: number;
	bytes: number;
	sha256: string;
}

/** `models.json` as written by `tools/data/09_export_maia3.py`. */
export interface MaiaManifest {
	upstream: { name: string; repo: string; commit: string; license: string };
	export: {
		script: string;
		opset: number;
		precision: string;
		torch: string;
		onnx: string;
		onnxruntime: string;
	};
	split: { partSuffix: string; partBytes: number };
	models: Record<
		string,
		{
			file: string;
			bytes: number;
			sha256: string;
			parts: number;
			params: number;
			upstream: { repo: string; revision: string; checkpoint: string; bytes: number; sha256: string };
			fixturePositions?: number;
			maxAbsProbDiffOnnxVsTorch?: number;
		}
	>;
}

export interface MaiaNotice {
	manifest: MaiaManifest;
	/** The whole files as the build ships them (joined from parts where the registry says so). */
	models: VendoredFile[];
	/** What the repository actually stores: whole files, or the `.part<i>` slices. */
	sources: VendoredFile[];
	sideFiles: VendoredFile[];
}

/** `models.json` as written by `tools/data/08_export_chessmimic.py`. */
export interface ModelsManifest {
	upstream: { repo: string; commit: string; license: string };
	export: {
		script: string;
		opset: number;
		precision: string;
		torch: string;
		onnx: string;
		onnxruntime: string;
	};
	bands: Record<
		string,
		{
			file: string;
			bytes: number;
			sha256: string;
			checkpoint: { path: string; lfsOid: string; bytes: number };
			fp32Bytes: number;
			weights: string;
			fixturePositions?: number;
			maxAbsProbDiffOnnxVsTorch?: number;
			/** Present when the band's weights were fine-tuned from the upstream checkpoint. */
			fineTuned?: { script: string; checkpointSha256: string; data: string };
		}
	>;
}

export interface ModelsNotice {
	manifest: ModelsManifest;
	bands: VendoredFile[];
	sideFiles: VendoredFile[];
}
