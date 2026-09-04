// test/scripts/gen-pagescript.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bindCode, DEV_SPOOF_SEED, defineProgram, emit, js, std } from "@pagescript";
import {
	generatePagescript,
	generatePrograms,
	renderEntry,
	renderModule,
} from "../../scripts/gen-pagescript";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "sl-gen-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const probe = defineProgram({
	name: "probe",
	params: { sel: "string", depth: "number", on: "boolean", cfg: "json" },
	build: (p) =>
		js.program([js.ret(js.arr(p.sel, p.depth, p.on, p.cfg, js.typeof_(js.spoof("ready"))))]),
});
const bridge = defineProgram({
	name: "test-bridge",
	params: { token: "string" },
	entry: true,
	entryArgs: { token: "t-0" },
	build: (p) =>
		js.program([js.const_("k", js.typeof_(js.spoof("hook"))), js.ret(js.arr(p.token, js.id("k")))]),
});
const bare = defineProgram({
	name: "bare",
	params: {},
	entry: true,
	build: () => js.program([js.ret(js.num(42))]),
});

describe("generatePagescript", () => {
	it("succeeds with an empty registry and still creates the directories", async () => {
		const dist = path.join(root, "empty-dist");
		const generatedDir = path.join(root, "empty-gen");
		const result = await generatePrograms(dist, { programs: [], generatedDir, seed: "s" });
		expect(result).toEqual({ seed: "s", generated: [], entries: [] });
		await expect(
			generatePagescript(dist, { programs: [], generatedDir, seed: "s" })
		).resolves.toBeUndefined();
		expect((await stat(generatedDir)).isDirectory()).toBe(true);
		expect((await stat(path.join(dist, "js", "page"))).isDirectory()).toBe(true);
		expect(await readdir(generatedDir)).toEqual([]);
	});

	it("writes a runtime-safe module per program whose bind() matches bindCode()", async () => {
		const dist = path.join(root, "dist");
		const generatedDir = path.join(root, "gen");
		const seed = "gen-seed";
		const result = await generatePrograms(dist, {
			programs: [probe, bridge, bare],
			generatedDir,
			seed,
		});
		expect(result.generated.map((f) => path.basename(f))).toEqual([
			"probe.ts",
			"test-bridge.ts",
			"bare.ts",
		]);
		const src = await readFile(path.join(generatedDir, "probe.ts"), "utf8");
		expect(src).not.toMatch(/^\s*import\b/m);
		expect(src).toContain("export const code = ");
		expect(src).toContain("export function bind(args: Args): string");
		expect(src).toContain("sel: string;");
		expect(src).toContain("depth: number;");
		expect(src).toContain("on: boolean;");
		expect(src).toContain("cfg: Json;");

		const mod = (await import(pathToFileURL(path.join(generatedDir, "probe.ts")).href)) as {
			name: string;
			code: string;
			params: readonly { name: string; type: string }[];
			bind: (args: Record<string, unknown>) => string;
		};
		const expected = emit(probe, { seed });
		expect(mod.name).toBe("probe");
		expect(mod.code).toBe(expected.code);
		expect(mod.params).toEqual(expected.params);
		const args = { sel: 'a"b', depth: 3, on: false, cfg: { c: [1, null] } };
		const bound = mod.bind(args);
		expect(bound).toBe(bindCode(expected.code, expected.params, args));
		expect(new Function(bound)()).toEqual(['a"b', 3, false, { c: [1, null] }, "undefined"]);
		expect(() => mod.bind({ sel: 1, depth: 3, on: false, cfg: null })).toThrow(/string/);
		expect(() => mod.bind({ depth: 3, on: false, cfg: null })).toThrow(/sel/);
	});

	it("writes an IIFE entry file for entry programs only, bound with entryArgs", async () => {
		const dist = path.join(root, "dist");
		const entryDir = path.join(dist, "js", "page");
		expect((await readdir(entryDir)).sort()).toEqual(["bare.js", "test-bridge.js"]);
		const entry = await readFile(path.join(entryDir, "test-bridge.js"), "utf8");
		expect(entry.startsWith("(() => {")).toBe(true);
		expect(entry.trimEnd().endsWith("})();")).toBe(true);
		expect(entry).not.toContain("$$param");
		expect(entry).not.toContain("$$spoof");
		expect(new Function(`return ${entry}`)()).toEqual(["t-0", "undefined"]);
		expect(new Function(`return ${await readFile(path.join(entryDir, "bare.js"), "utf8")}`)()).toBe(
			42
		);
	});

	it("uses the same seed for module code and entry files", async () => {
		const dist = path.join(root, "seed-dist");
		const generatedDir = path.join(root, "seed-gen");
		const { seed } = await generatePrograms(dist, { programs: [bridge], generatedDir });
		expect(seed).toBe(process.env.SL_SPOOF_SEED ?? DEV_SPOOF_SEED);
		const mod = await readFile(path.join(generatedDir, "test-bridge.ts"), "utf8");
		const entry = await readFile(path.join(dist, "js", "page", "test-bridge.js"), "utf8");
		const token = /const k = typeof (\w+);/.exec(entry)?.[1];
		expect(token).toBeDefined();
		expect(mod).toContain(`const k = typeof ${token};`);
		expect(emit(bridge, { seed }).code).toContain(`const k = typeof ${token};`);
	});

	it("rejects an entry program with parameters but no entryArgs, and duplicate names", async () => {
		const dist = path.join(root, "bad-dist");
		const generatedDir = path.join(root, "bad-gen");
		const noArgs = defineProgram({
			name: "no-args",
			params: { sel: "string" },
			entry: true,
			build: (p) => js.program([js.ret(std.query(p.sel))]),
		});
		await expect(
			generatePrograms(dist, { programs: [noArgs], generatedDir, seed: "s" })
		).rejects.toThrow(/entryArgs/);
		await expect(
			generatePagescript(dist, { programs: [bare, bare], generatedDir, seed: "s" })
		).rejects.toThrow(/duplicate/);
	});

	it("renderModule / renderEntry are pure templates", () => {
		const src = renderModule("x", [], "return 1;");
		expect(src).toContain('export const name = "x";');
		expect(src).toContain("export type Args = Record<string, never>;");
		expect(renderEntry("return 1;")).toBe("(() => {\nreturn 1;\n})();\n");
	});
});
