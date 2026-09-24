/**
 * tools/lib/engine/review-referee.ts — the exact shipped full engine, launched under V8 rather
 * than a Bun SIMD substitute: `review-worker.node.ts` is bundled for Node and driven over JSON
 * lines on its stdin/stdout, one search at a time.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { ROOT } from "../paths";
import type { RefereeEngine, RefereeOptions, ReviewEngineProvenance, SearchFrame } from "./types";

export async function createReviewReferee(
	options: RefereeOptions
): Promise<RefereeEngine & { provenance: ReviewEngineProvenance }> {
	const node = Bun.which("node");
	if (!node) throw new Error("Review benchmark requires Node/V8 on PATH");
	const dir = await mkdtemp(path.join(tmpdir(), "sliced-review-node-"));
	const build = await Bun.build({
		entrypoints: [path.join(import.meta.dir, "review-worker.node.ts")],
		outdir: dir,
		naming: "[name].mjs",
		target: "node",
		format: "esm",
		define: { __SL_LICENSE_ENFORCE__: "false" },
	});
	if (!build.success) throw new AggregateError(build.logs, "Cannot bundle review worker");
	const child = Bun.spawn(
		[
			node,
			path.join(dir, "review-worker.node.mjs"),
			ROOT,
			String(options.threads ?? 1),
			String(options.hashMb ?? 64),
		],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		}
	);
	const rows = createInterface({ input: Readable.fromWeb(child.stdout as never) })[
		Symbol.asyncIterator
	]();
	const receive = async () => {
		const row = await rows.next();
		if (row.done) throw new Error(`Review worker exited (${await child.exited})`);
		return JSON.parse(row.value);
	};
	const { provenance } = (await receive()) as { provenance: ReviewEngineProvenance };
	let chain = Promise.resolve();
	const send = async (message: unknown) => {
		child.stdin.write(`${JSON.stringify(message)}\n`);
		await child.stdin.flush();
		return receive();
	};
	return {
		provenance,
		search(spec) {
			const result = chain.then(() => send(spec)) as Promise<SearchFrame>;
			chain = result.then(() => undefined);
			return result;
		},
		newGame() {
			chain = chain.then(() => send({ newGame: true })).then(() => undefined);
		},
		dispose() {
			child.stdin.end();
		},
	};
}
