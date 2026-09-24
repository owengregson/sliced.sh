/**
 * tools/calibration/frames/coordinator.ts — the frame cache run: merge what an interrupted run
 * left, select the rows still to search, feed them to worker processes (a crashed row is retried
 * once elsewhere; a worker that dies at startup is respawned up to a limit), report progress and
 * merge the parts into `--out`.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../../lib/paths";
import type { FramesArgs } from "./args";
import { selectRows } from "./select";
import { idsIn, loadPolicies, mergeParts } from "./store";
import type { Task, WorkerMessage } from "./worker";

/** Workers that die before their first message; past this many the run stops respawning. */
const MAX_STARTUP_FAILURES = 3;

function fmtDuration(s: number): string {
	if (!Number.isFinite(s)) return "?";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0
		? `${h}h${String(m).padStart(2, "0")}m`
		: `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Search every selected row not yet cached, over `args.workers` processes running `entry`. */
export async function runCoordinator(args: FramesArgs, entry: string): Promise<void> {
	const started = performance.now();
	mkdirSync(path.dirname(args.out), { recursive: true });
	const partsDir = `${args.out}.parts`;
	const recovered = await mergeParts(args.out, partsDir);
	if (recovered > 0) console.log(`merged ${recovered} records left by an interrupted run`);
	const done = new Set<string>();
	await idsIn(args.out, done);
	const selected = await selectRows(args);
	const todo = selected.filter((r) => !done.has(r.id));
	console.log(
		`${selected.length} rows selected, ${selected.length - todo.length} already cached, ${todo.length} to search`
	);
	if (todo.length === 0) return;
	const policies = await loadPolicies(args.policies, new Set(todo.map((r) => r.id)));
	if (args.requirePolicies) {
		const ready = todo.filter((r) => policies.has(r.id));
		console.log(`--require-policies: ${ready.length}/${todo.length} rows have their policies`);
		todo.splice(0, todo.length, ...ready);
		if (todo.length === 0) return;
	}
	console.log(
		args.policies && existsSync(args.policies)
			? `policies for ${policies.size}/${todo.length} rows`
			: "no policies: the extra searchmoves pass is skipped"
	);
	mkdirSync(partsDir, { recursive: true });

	const queue = todo.map((r) => ({ ...r, attempts: 0 }));
	const perTc = new Map<string, { n: number; ms: number }>();
	let finished = 0;
	let failed = 0;
	let lastReport = 0;
	const total = todo.length;
	const report = (force = false): void => {
		const now = performance.now();
		if (!force && now - lastReport < 5_000) return;
		lastReport = now;
		const secs = (now - started) / 1000;
		const rate = finished / secs;
		console.log(
			`${finished}/${total} rows (${failed} failed) · ${rate.toFixed(2)} rows/s · ETA ${fmtDuration((total - finished) / rate)}`
		);
	};
	const tcOf = new Map(todo.map((r) => [r.id, r.row.tc]));

	const workerCount = Math.min(args.workers, total);
	let startupFailures = 0;
	let nextWorker = 0;
	const spawnWorker = (): Promise<void> =>
		new Promise((resolve) => {
			const index = nextWorker++;
			const partFile = path.join(partsDir, `part-${String(index).padStart(3, "0")}.jsonl`);
			let current: (typeof queue)[number] | undefined;
			let exiting = false;
			let ready = false;
			const feed = (): void => {
				current = queue.shift();
				if (current === undefined) {
					exiting = true;
					child.send({ type: "exit" });
					return;
				}
				child.send({
					type: "task",
					id: current.id,
					row: current.row,
					policies: policies.get(current.id) ?? [],
				} satisfies Task);
			};
			const child = Bun.spawn([process.execPath, entry, "--worker", partFile], {
				cwd: ROOT,
				stdout: "inherit",
				stderr: "inherit",
				serialization: "json",
				ipc(raw) {
					const msg = raw as WorkerMessage;
					ready = true;
					if (msg.type === "done") {
						finished++;
						const tc = tcOf.get(msg.id) ?? "?";
						const agg = perTc.get(tc) ?? { n: 0, ms: 0 };
						agg.n++;
						agg.ms += msg.ms;
						perTc.set(tc, agg);
						report();
					} else if (msg.type === "failed") {
						finished++;
						failed++;
						console.error(`skip ${msg.id}: ${msg.error}`);
					}
					feed();
				},
			});
			void child.exited.then(async (code) => {
				if (!exiting) {
					// Crashed mid-row: retry that row once elsewhere, then respawn if work remains.
					console.error(`worker ${index} exited (${code}) during ${current?.id ?? "startup"}`);
					if (current) {
						current.attempts++;
						if (current.attempts <= 1) queue.push(current);
						else {
							finished++;
							failed++;
							console.error(`skip ${current.id}: worker crashed twice`);
						}
					}
					if (!ready) startupFailures++;
					if (queue.length > 0 && startupFailures < MAX_STARTUP_FAILURES) await spawnWorker();
				}
				resolve();
			});
		});
	await Promise.all(Array.from({ length: workerCount }, () => spawnWorker()));
	report(true);
	if (queue.length > 0)
		console.error(
			`${queue.length} rows left unsearched: workers failed to start ${startupFailures}×`
		);
	const merged = await mergeParts(args.out, partsDir);
	const wall = (performance.now() - started) / 1000;
	console.log(`merged ${merged} records into ${args.out} in ${fmtDuration(wall)}`);
	for (const [tc, agg] of [...perTc].sort()) {
		const mean = agg.ms / agg.n / 1000;
		console.log(
			`  ${tc}: ${agg.n} rows · ${mean.toFixed(2)} s/row per worker · ≈ ${(mean / workerCount).toFixed(3)} s/row at ${workerCount} workers`
		);
	}
	console.log(`  overall: ${(wall / Math.max(1, finished)).toFixed(3)} s/row wall`);
}
