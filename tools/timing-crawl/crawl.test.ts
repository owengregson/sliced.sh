// tools/timing-crawl/crawl.test.ts — the crawl's own seams: the torn-tail trim, the frontier's
// reservoir and validated pops, and the synchronous JSONL reader the replay runs on.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJsonlSync } from "../lib/jsonl";
import { dropTornTail } from "./crawl/files";
import { Frontier } from "./crawl/frontier";
import { DEFAULT_CAPS, Ledger, rng } from "./policy";

const dir = mkdtempSync(path.join(tmpdir(), "timing-crawl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("files", () => {
	it("drops a torn last line and keeps whole lines", () => {
		const f = path.join(dir, "torn.jsonl");
		writeFileSync(f, '{"a":1}\n{"a":2}\n{"a"');
		dropTornTail(f);
		expect(readFileSync(f, "utf8")).toBe('{"a":1}\n{"a":2}\n');
		dropTornTail(f);
		expect(readFileSync(f, "utf8")).toBe('{"a":1}\n{"a":2}\n');
		writeFileSync(f, "no newline at all");
		dropTornTail(f);
		expect(readFileSync(f, "utf8")).toBe("");
	});

	it("reads JSONL synchronously, skipping blank and torn lines", () => {
		const f = path.join(dir, "lines.jsonl");
		writeFileSync(f, '{"a":1}\n\n{"a":\n{"a":3}');
		expect([...readJsonlSync<{ a: number }>(f)].map((x) => x.a)).toEqual([1, 3]);
		expect([...readJsonlSync(path.join(dir, "missing.jsonl"))]).toEqual([]);
	});
});

describe("frontier", () => {
	const make = (candCap: number) =>
		new Frontier(new Ledger(DEFAULT_CAPS), { candCap, cellCap: DEFAULT_CAPS.cellCap }, rng(3));

	it("files a player under the cell of the rating seen, once, and never a visited one", () => {
		const f = make(10);
		f.note("Alice", "blitz", 1450);
		f.note("alice", "blitz", 1450);
		f.visited.add("bob");
		f.note("Bob", "blitz", 1450);
		f.note("Carol", "blitz", 500);
		expect(f.candidates.get("blitz:1400")).toEqual(["alice"]);
		expect(f.size("blitz:1400")).toBe(1);
	});

	it("keeps a reservoir of candCap names and pops each at most once", () => {
		const f = make(3);
		for (const n of ["a", "b", "c", "d", "e"]) f.file("rapid:2000", n);
		expect(f.size("rapid:2000")).toBe(3);
		const popped = new Set<string>();
		for (let name = f.pop("rapid:2000"); name; name = f.pop("rapid:2000")) popped.add(name);
		expect(popped.size).toBe(3);
		expect(f.pop("rapid:2000")).toBeNull();
	});
});
