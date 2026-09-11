/** A separate offscreen-like runtime so native inference cannot block service-side expiry timers. */
import path from "node:path";
import { pathToFileURL } from "node:url";

(globalThis as Record<string, unknown>).__SL_LICENSE_ENFORCE__ = false;
const { createOrtRuntime } = await import("@offscreen/ort-loader");
const { createTimingInference } = await import("@offscreen/timing-inference");
const root = path.resolve(import.meta.dir, "../../..");
const inference = createTimingInference({
	runtime: () =>
		createOrtRuntime({
			importModule: (url) => import(url),
			getUrl: (file) => pathToFileURL(path.join(root, file)).href,
			threads: 1,
		}),
	store: {
		get: async (name) =>
			new Uint8Array(await Bun.file(path.join(root, "assets/models/chessmimic", name)).arrayBuffer()),
	},
});
await inference.warm("1500_1600");
console.log(JSON.stringify({ ready: true }));
let carry = "";
const reader = Bun.stdin.stream().getReader();
try {
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		carry += new TextDecoder().decode(chunk.value);
		while (true) {
			const end = carry.indexOf("\n");
			if (end < 0) break;
			const line = carry.slice(0, end);
			carry = carry.slice(end + 1);
			if (!line) continue;
			const command = JSON.parse(line) as Parameters<typeof inference.handle>[0];
			const result = await inference.handle(command);
			console.log(JSON.stringify(result));
		}
	}
} finally {
	reader.releaseLock();
	inference.dispose();
}
