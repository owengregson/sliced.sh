import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { MODEL_PACKING } from "@core/constants/model-packing";
import { unpackModelResponse } from "@offscreen/model-unpack";
import { packModel, verifyPackedModel } from "../../scripts/model-packing";

function hash(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function response(data: Uint8Array, chunkBytes = 31): Response {
	let offset = 0;
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (offset === data.length) return controller.close();
				const end = Math.min(data.length, offset + chunkBytes);
				controller.enqueue(data.slice(offset, end));
				offset = end;
			},
		})
	);
}

describe("lossless model packages", () => {
	it("roundtrips odd tails and multiple blocks through the browser streaming decoder", async () => {
		for (const length of [1, 2, 3, MODEL_PACKING.blockBytes, MODEL_PACKING.blockBytes * 2 + 103]) {
			const data = Uint8Array.from({ length }, (_, i) => (i * 97 + Math.floor(i / 11)) % 256);
			const packed = packModel(data);
			verifyPackedModel(packed, data.length, hash(data));
			expect(hash(await unpackModelResponse(response(packed, length < 4 ? 1 : 31), data.length))).toBe(
				hash(data)
			);
		}
	});
	it("supports fetch fakes without a streaming body", async () => {
		const data = Uint8Array.of(1, 2, 3);
		const packed = packModel(data);
		expect(
			await unpackModelResponse({ arrayBuffer: async () => Uint8Array.from(packed).buffer }, 3)
		).toEqual(data);
	});
	it("rejects wrong versions, lengths, truncated streams, excess data and corruption", async () => {
		const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
		const packed = packModel(data);
		await expect(unpackModelResponse(response(packed), data.length + 1)).rejects.toThrow(
			"length mismatch"
		);
		await expect(
			unpackModelResponse(response(packed.subarray(0, -3)), data.length)
		).rejects.toThrow();
		const encoded = gunzipSync(packed);
		const wrongVersion = Buffer.from(encoded);
		wrongVersion[0] = 0;
		await expect(unpackModelResponse(response(gzipSync(wrongVersion)), data.length)).rejects.toThrow(
			"format"
		);
		await expect(
			unpackModelResponse(response(gzipSync(encoded.subarray(0, -1))), data.length)
		).rejects.toThrow("truncated");
		await expect(
			unpackModelResponse(response(gzipSync(Buffer.concat([encoded, Buffer.of(0)]))), data.length)
		).rejects.toThrow("excess");
		expect(() => verifyPackedModel(packed, data.length, "0".repeat(64))).toThrow("checksum");
	});
});
