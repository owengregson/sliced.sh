import { MODEL_PACKING } from "@core/constants/model-packing";

export interface PackedModelResponse {
	body?: ReadableStream<Uint8Array> | null;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** Decode one block at a time into the final ONNX buffer, without a second full-sized copy. */
export async function unpackModelResponse(
	response: PackedModelResponse,
	expectedBytes: number
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)
		throw new Error("invalid model length");
	const source = (response.body ??
		new Blob([await response.arrayBuffer()]).stream()) as ReadableStream<BufferSource>;
	const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
	const header = new Uint8Array(MODEL_PACKING.headerBytes);
	let headerUsed = 0;
	let output: Uint8Array | undefined;
	const block = new Uint8Array(Math.min(expectedBytes, MODEL_PACKING.blockBytes));
	let blockUsed = 0;
	let written = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			let offset = 0;
			if (!output) {
				const take = Math.min(header.length - headerUsed, value.length);
				header.set(value.subarray(0, take), headerUsed);
				headerUsed += take;
				offset += take;
				if (headerUsed < header.length) continue;
				const magic = String.fromCharCode(...header.subarray(0, 4));
				if (magic !== MODEL_PACKING.magic) throw new Error("unsupported packed model format");
				if (new DataView(header.buffer).getUint32(4, true) !== expectedBytes)
					throw new Error("packed model length mismatch");
				output = new Uint8Array(expectedBytes);
			}
			while (offset < value.length) {
				const blockBytes = Math.min(block.length, expectedBytes - written);
				if (blockBytes <= 0) throw new Error("packed model has excess bytes");
				const take = Math.min(blockBytes - blockUsed, value.length - offset);
				block.set(value.subarray(offset, offset + take), blockUsed);
				blockUsed += take;
				offset += take;
				if (blockUsed !== blockBytes) continue;
				const evenBytes = Math.ceil(blockBytes / 2);
				for (let i = 0; i < evenBytes; i++) output[written + i * 2] = block[i] ?? 0;
				for (let i = 0; i < blockBytes - evenBytes; i++)
					output[written + i * 2 + 1] = block[evenBytes + i] ?? 0;
				written += blockBytes;
				blockUsed = 0;
			}
		}
		if (!output || written !== expectedBytes || blockUsed !== 0)
			throw new Error("packed model is truncated");
		return output;
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
