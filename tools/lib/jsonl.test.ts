import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { headId, jsonlLines, readJsonl } from "./jsonl";

const dir = mkdtempSync(path.join(os.tmpdir(), "jsonl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("jsonl", () => {
	it("streams trimmed non-blank lines, the last one without a newline too", async () => {
		const file = path.join(dir, "a.jsonl");
		writeFileSync(file, '{"id":"a"}\n\n  {"id":"b"}  \n{"id":"c"}');
		const lines: string[] = [];
		for await (const line of jsonlLines(file)) lines.push(line);
		expect(lines).toEqual(['{"id":"a"}', '{"id":"b"}', '{"id":"c"}']);
		expect(readJsonl<{ id: string }>(file).map((r) => r.id)).toEqual(["a", "b", "c"]);
	});

	it("throws on a missing file and peeks only a leading id", () => {
		expect(() => readJsonl(path.join(dir, "none.jsonl"))).toThrow("missing");
		expect(headId('{"id":"x\\"y","policies":[]}')).toBe('x"y');
		expect(headId('{"policies":[],"id":"x"}')).toBeNull();
	});
});
