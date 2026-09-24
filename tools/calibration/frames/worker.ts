/**
 * tools/calibration/frames/worker.ts — one search process: a referee of its own, rows fed over IPC
 * by the coordinator, each record appended to the worker's part file; a failed row is retried once
 * on a fresh engine, and an orphaned worker exits.
 */

import { appendFile } from "node:fs/promises";
import { computeFrame, createFrameEngine } from "./recipe";
import type { CalibrationRow, GridPolicy } from "./schema";

export interface Task {
	type: "task";
	id: string;
	row: CalibrationRow;
	policies: GridPolicy[];
}

export type WorkerMessage =
	| { type: "ready" }
	| { type: "done"; id: string; ms: number }
	| { type: "failed"; id: string; error: string };

export async function runWorker(partFile: string): Promise<void> {
	const send = (m: WorkerMessage): void => {
		process.send?.(m);
	};
	let engine = await createFrameEngine();
	const restart = async (): Promise<void> => {
		engine.dispose();
		engine = await createFrameEngine();
	};
	let queue = Promise.resolve();
	// An orphaned worker (the coordinator killed) stops instead of idling on a dead channel.
	process.on("disconnect", () => {
		engine.dispose();
		process.exit(0);
	});
	process.on("message", (raw: unknown) => {
		const msg = raw as Task | { type: "exit" };
		if (msg.type === "exit") {
			queue = queue.then(() => {
				engine.dispose();
				process.exit(0);
			});
			return;
		}
		queue = queue.then(async () => {
			let lastError = "";
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const record = await computeFrame(engine, msg.row, msg.id, msg.policies);
					await appendFile(partFile, `${JSON.stringify(record)}\n`);
					send({ type: "done", id: msg.id, ms: record.ms });
					return;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					await restart().catch((e: unknown) => {
						lastError += ` | restart failed: ${String(e)}`;
					});
				}
			}
			send({ type: "failed", id: msg.id, error: lastError });
		});
	});
	send({ type: "ready" });
}
