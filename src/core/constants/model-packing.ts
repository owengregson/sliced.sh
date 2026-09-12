/** Lossless package encoding; canonical ONNX files and their hashes remain unchanged. */
export const MODEL_PACKING = {
	suffix: ".pack.gz",
	magic: "SLM1",
	headerBytes: 8,
	blockBytes: 1024 * 1024,
} as const;

export function packagedModelName(file: string, packed = false): string {
	return packed ? file + MODEL_PACKING.suffix : file;
}
