import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { MODEL_PACKING } from "../src/core/constants/model-packing";

/** Group alternating bytes in 1 MiB blocks so gzip can compress the fp16 exponent bytes. */
export function packModel(data: Uint8Array): Uint8Array {
	if (data.length <= 0 || data.length > 0xffffffff) throw new Error("invalid model length");
	const encoded = new Uint8Array(MODEL_PACKING.headerBytes + data.length);
	encoded.set(new TextEncoder().encode(MODEL_PACKING.magic));
	new DataView(encoded.buffer).setUint32(4, data.length, true);
	for (let at = 0; at < data.length; at += MODEL_PACKING.blockBytes) {
		const length = Math.min(MODEL_PACKING.blockBytes, data.length - at);
		const evenBytes = Math.ceil(length / 2);
		const base = MODEL_PACKING.headerBytes + at;
		for (let i = 0; i < evenBytes; i++) encoded[base + i] = data[at + i * 2] ?? 0;
		for (let i = 0; i < length - evenBytes; i++)
			encoded[base + evenBytes + i] = data[at + i * 2 + 1] ?? 0;
	}
	return gzipSync(encoded, { level: 9 });
}

/** Build-time verifier, independent of the browser streaming implementation. */
export function verifyPackedModel(data: Uint8Array, bytes: number, sha256: string): void {
	const decoded = gunzipSync(data, { maxOutputLength: bytes + MODEL_PACKING.headerBytes });
	if (
		decoded.length !== bytes + MODEL_PACKING.headerBytes ||
		decoded.toString("ascii", 0, 4) !== MODEL_PACKING.magic ||
		decoded.readUInt32LE(4) !== bytes
	)
		throw new Error("packed model header or length mismatch");
	const hash = createHash("sha256");
	const block = new Uint8Array(MODEL_PACKING.blockBytes);
	for (let at = 0; at < bytes; at += block.length) {
		const length = Math.min(block.length, bytes - at);
		const evenBytes = Math.ceil(length / 2);
		const base = MODEL_PACKING.headerBytes + at;
		for (let i = 0; i < evenBytes; i++) block[i * 2] = decoded[base + i] ?? 0;
		for (let i = 0; i < length - evenBytes; i++)
			block[i * 2 + 1] = decoded[base + evenBytes + i] ?? 0;
		hash.update(block.subarray(0, length));
	}
	if (hash.digest("hex") !== sha256) throw new Error("packed model checksum mismatch");
}
