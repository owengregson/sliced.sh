// test/service/handlers/engine.test.ts
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { MSG } from "@core/constants/messages";
import { URLS } from "@core/constants/urls";
import { installMessageRouter } from "@core/messaging/router";
import { base64ToBytes } from "@core/util/base64";
import { registerEngineHandlers } from "@service/handlers/engine";
import { attachNnueDownload, encodeNnueChunks } from "@service/handlers/engine/nnue-download";
import type { EngineStatus } from "@typedefs/engine";

const SENDER = {} as chrome.runtime.MessageSender;

function fakePort() {
	const listeners = new Set<(m: EnginePortMessage) => void>();
	const posted: EnginePortCommand[] = [];
	return {
		posted,
		onMessage(cb: (m: EnginePortMessage) => void): () => void {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		post(cmd: EnginePortCommand): void {
			posted.push(cmd);
		},
		emit(m: EnginePortMessage): void {
			for (const l of listeners) l(m);
		},
	};
}

describe("encodeNnueChunks", () => {
	it("splits raw bytes into base64 chunks of at most chunkBytes that concatenate back", () => {
		const data = new Uint8Array(10_000).map((_, i) => i & 0xff);
		const chunks = encodeNnueChunks("nn-x.nnue", data, 4096);
		expect(chunks).toHaveLength(3);
		const parts = chunks.map((c) => ("bytes" in c ? base64ToBytes(c.bytes) : new Uint8Array()));
		expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
		const joined = new Uint8Array(10_000);
		let at = 0;
		for (const p of parts) {
			joined.set(p, at);
			at += p.length;
		}
		expect(joined).toEqual(data);
		expect(chunks.map((c) => ("index" in c ? [c.index, c.total] : null))).toEqual([
			[0, 3],
			[1, 3],
			[2, 3],
		]);
		expect(encodeNnueChunks("nn-x.nnue", new Uint8Array(), 4096)).toHaveLength(1);
	});
});

describe("attachNnueDownload", () => {
	it("fetches the net from the mirror and streams chunks back over the same port", async () => {
		const port = fakePort();
		const data = new Uint8Array(LIMITS.nnueChunkBytes + 5).fill(7);
		const fetched: string[] = [];
		const detach = attachNnueDownload(port, {
			fetch: async (url: string) => {
				fetched.push(url);
				return { ok: true, status: 200, arrayBuffer: async () => data.slice().buffer };
			},
		});
		port.emit({ kind: "nnue-request", name: "nn-c288c895ea92.nnue" });
		await new Promise((r) => setTimeout(r, 0));
		expect(fetched).toEqual([`${URLS.nnueMirror}nn-c288c895ea92.nnue`]);
		expect(port.posted).toHaveLength(2);
		expect(port.posted[0]).toMatchObject({ kind: "nnue-chunk", index: 0, total: 2 });
		expect(port.posted[1]).toMatchObject({ kind: "nnue-chunk", index: 1, total: 2 });
		detach();
		port.emit({ kind: "nnue-request", name: "nn-c288c895ea92.nnue" });
		await new Promise((r) => setTimeout(r, 0));
		expect(fetched).toHaveLength(1);
	});

	it("posts an error chunk when the fetch fails or the response is not ok", async () => {
		const port = fakePort();
		attachNnueDownload(port, {
			fetch: async (url: string) => {
				if (url.endsWith("boom.nnue")) throw new Error("network down");
				return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
			},
		});
		port.emit({ kind: "nnue-request", name: "nn-boom.nnue" });
		port.emit({ kind: "nnue-request", name: "nn-missing.nnue" });
		await new Promise((r) => setTimeout(r, 0));
		expect(port.posted).toEqual([
			{ kind: "nnue-chunk", name: "nn-boom.nnue", error: "network down" },
			{ kind: "nnue-chunk", name: "nn-missing.nnue", error: "HTTP 404" },
		]);
	});
});

describe("registerEngineHandlers", () => {
	it("routes PANEL_ENGINE_RESTART to restart() and OFFSCREEN_ENGINE_STATUS to the status cache", async () => {
		const router = installMessageRouter();
		let restarts = 0;
		let status: EngineStatus | undefined;
		const port = fakePort();
		const engine = {
			restart: async () => {
				restarts++;
			},
			status: () => status,
			onMessage: port.onMessage,
			post: port.post,
		};
		registerEngineHandlers(router, engine, {
			fetch: async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }),
		});
		expect(await router._dispatch({ type: MSG.PANEL_ENGINE_RESTART }, SENDER)).toEqual({
			success: true,
			response: undefined,
		});
		expect(restarts).toBe(1);
		const unknown = await router._dispatch({ type: MSG.OFFSCREEN_ENGINE_STATUS }, SENDER);
		expect(unknown).toMatchObject({ success: true, response: { state: "booting" } });
		status = { state: "ready", variant: "full", threads: 2, nnue: [], version: "x" };
		expect(await router._dispatch({ type: MSG.OFFSCREEN_ENGINE_STATUS }, SENDER)).toEqual({
			success: true,
			response: status,
		});
		port.emit({ kind: "nnue-request", name: "nn-a.nnue" });
		await new Promise((r) => setTimeout(r, 0));
		expect(port.posted).toEqual([{ kind: "nnue-chunk", name: "nn-a.nnue", error: "HTTP 500" }]);
	});
});
