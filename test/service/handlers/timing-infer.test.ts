// test/service/handlers/timing-infer.test.ts — Task 34: the service-worker side of the timing
// port (`createTimingInferPort` correlates `timing` → `timing-result`) and the on-demand band
// relay (`attachModelDownload`).
import { describe, expect, it } from "bun:test";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { URLS } from "@core/constants/urls";
import type { ChessMimicInputs } from "@core/timing/chessmimic-head";
import { base64ToBytes } from "@core/util/base64";
import { attachModelDownload, encodeModelChunks } from "@service/handlers/engine/model-download";
import { createTimingInferPort } from "@service/handlers/engine/timing-infer";

function fakePort() {
	const posted: EnginePortCommand[] = [];
	const listeners = new Set<(m: EnginePortMessage) => void>();
	return {
		posted,
		post(cmd: EnginePortCommand) {
			posted.push(cmd);
		},
		onMessage(cb: (m: EnginePortMessage) => void) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		emit(m: EnginePortMessage) {
			for (const l of [...listeners]) l(m);
		},
		listeners,
	};
}

const inputs: ChessMimicInputs = {
	band: "1500_1600",
	moveTokens: new Array<number>(12).fill(32),
	fenTokens: new Array<number>(78).fill(30),
	rating: 1550,
	playerClockS: 120,
	opponentClockS: 120,
	incrementS: 0,
};

describe("createTimingInferPort", () => {
	it("posts a timing command with a unique id and resolves with the matching result", async () => {
		const port = fakePort();
		const client = createTimingInferPort(port);
		const p1 = client.infer(inputs);
		const p2 = client.infer({ ...inputs, band: "1800_1900" });
		expect(port.posted).toHaveLength(2);
		const [c1, c2] = port.posted;
		if (c1?.kind !== "timing" || c2?.kind !== "timing") throw new Error("expected timing commands");
		expect(c1.id).not.toBe(c2.id);
		expect(c1.inputs).toEqual(inputs);
		const probs = new Array<number>(30).fill(1 / 30);
		port.emit({ kind: "timing-result", id: c2.id, probs, band: "1800_1900", ms: 31 });
		port.emit({ kind: "timing-result", id: "unknown", probs, band: "1500_1600" });
		port.emit({ kind: "timing-result", id: c1.id, probs, band: "1500_1600", ms: 30 });
		expect(await p1).toEqual({ probs, band: "1500_1600", ms: 30 });
		expect(await p2).toEqual({ probs, band: "1800_1900", ms: 31 });
	});
	it("resolves null on an error result (the head falls back to v1)", async () => {
		const port = fakePort();
		const client = createTimingInferPort(port);
		const p = client.infer(inputs);
		const c = port.posted[0];
		if (c?.kind !== "timing") throw new Error("expected timing command");
		port.emit({ kind: "timing-result", id: c.id, probs: null, error: "not-available" });
		expect(await p).toBeNull();
	});
	it("warm posts timing-warm and dispose settles pending queries with null and stops listening", async () => {
		const port = fakePort();
		const client = createTimingInferPort(port);
		client.warm("1200_1300");
		expect(port.posted).toEqual([{ kind: "timing-warm", band: "1200_1300" }]);
		const p = client.infer(inputs);
		client.dispose();
		expect(await p).toBeNull();
		expect(port.listeners.size).toBe(0);
	});
});

describe("attachModelDownload", () => {
	it("fetches a registered band from URLS.chessmimicBandBase and streams model-chunks back", async () => {
		const port = fakePort();
		const data = new Uint8Array(1500).map((_, i) => i & 0xff);
		const urls: string[] = [];
		const detach = attachModelDownload(port, {
			fetch: async (url) => {
				urls.push(url);
				return { ok: true, status: 200, arrayBuffer: async () => data.slice().buffer };
			},
			chunkBytes: 1000,
		});
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		expect(urls).toEqual([`${URLS.chessmimicBandBase}1000_1100.onnx`]);
		expect(port.posted).toHaveLength(2);
		const [a, b] = port.posted;
		if (a?.kind !== "model-chunk" || b?.kind !== "model-chunk" || !("bytes" in a) || !("bytes" in b))
			throw new Error("expected data chunks");
		expect([a.index, a.total, b.index, b.total]).toEqual([0, 2, 1, 2]);
		const joined = new Uint8Array([...base64ToBytes(a.bytes), ...base64ToBytes(b.bytes)]);
		expect(joined).toEqual(data);
		expect([...encodeModelChunks("x.onnx", data, 1000)]).toHaveLength(2);
		detach();
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		expect(urls).toHaveLength(1);
	});
	it("reports an HTTP failure as an error chunk", async () => {
		const port = fakePort();
		attachModelDownload(port, {
			fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
		});
		port.emit({ kind: "model-request", name: "1000_1100.onnx" });
		await new Promise((r) => setTimeout(r, 5));
		expect(port.posted).toEqual([{ kind: "model-chunk", name: "1000_1100.onnx", error: "HTTP 404" }]);
	});
});
