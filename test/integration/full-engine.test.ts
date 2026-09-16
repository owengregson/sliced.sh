import { describe, expect, it } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_DIR, ENGINE_FILES, ENGINE_NNUE_SOURCES } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import { writeBundledNnue } from "../../scripts/nnue-assets";
import type { FullEngineReport } from "./full-engine.node";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("Stockfish 19 full (real packaged NNUE and wasm)", () => {
	it("boots and searches using installed raw networks with no cache or download relay", async () => {
		const node = Bun.which("node");
		if (!node)
			throw new Error(
				"The full-engine integration test requires Node.js on PATH (see docs/DEVELOPMENT.md)."
			);
		const dir = await mkdtemp(path.join(tmpdir(), "sliced-full-engine-"));
		try {
			await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
			const installed = path.join(dir, ENGINE_DIR);
			await writeBundledNnue(
				path.join(ROOT, ENGINE_DIR),
				installed,
				ENGINE_NNUE_SOURCES.filter((spec) => spec.name !== ENGINE_FILES.smallnet.nnue)
			);
			for (const name of [ENGINE_FILES.full.js, ENGINE_FILES.full.wasm]) {
				await copyFile(path.join(ROOT, ENGINE_DIR, name), path.join(installed, name));
			}
			expect((await readdir(installed)).some((name) => name.endsWith(".gz"))).toBe(false);
			// V8 executes the shipped relaxed-SIMD program and real pthreads. Bun's plain-SIMD
			// substitute intermittently traps in its pthread trampoline during full-suite runs.
			const build = await Bun.build({
				entrypoints: [path.join(import.meta.dir, "full-engine.node.ts")],
				outdir: dir,
				naming: "[name].mjs",
				target: "node",
				format: "esm",
				define: { __SL_LICENSE_ENFORCE__: "false" },
			});
			if (!build.success)
				throw new AggregateError(build.logs, "Could not bundle the Node engine fixture");
			const reportFile = path.join(dir, "report.json");
			const child = Bun.spawn([node, path.join(dir, "full-engine.node.mjs"), dir, reportFile], {
				stdout: "pipe",
				stderr: "pipe",
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 20_000);
			let exitCode: number;
			let stdout: string;
			let stderr: string;
			try {
				[exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
			} finally {
				clearTimeout(timer);
			}
			if (timedOut || exitCode !== 0) {
				throw new Error(
					`Node full-engine fixture ${timedOut ? "timed out" : `exited ${exitCode}`}\n${stdout}\n${stderr}`
				);
			}
			const report: FullEngineReport = await Bun.file(reportFile).json();
			expect(report.runtime).toBe("node");
			expect(report.module).toBe(ENGINE_FILES.full.js);
			expect(report.lines).toContain(
				`option name UCI_Elo type spin default ${LIMITS.engineEloMin} min ${LIMITS.engineEloMin} max ${LIMITS.engineEloMax}`
			);
			expect(report.best).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);
			expect(report.lines.some((line) => /^info depth 8 /.test(line))).toBe(true);
			expect(report.nnue).toEqual([...ENGINE_FILES.full.nnue]);
			expect(report.reads).toEqual(
				ENGINE_FILES.full.nnue.map((name) => pathToFileURL(path.join(installed, name)).href)
			);
			expect(report.requests).toEqual([]);
			expect(report.errors).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 25_000);
});
