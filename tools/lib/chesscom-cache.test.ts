import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheName, encodeCache, readCache } from "./chesscom-cache";

const dir = mkdtempSync(path.join(os.tmpdir(), "cc-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("chess.com response cache", () => {
	it("names an entry by sha1 of its URL and reads back what it wrote", () => {
		expect(cacheName("https://api.chess.com/pub/leaderboards")).toMatch(/^[0-9a-f]{40}\.json\.gz$/);
		const file = path.join(dir, cacheName("u"));
		const entry = { url: "u", status: 404, body: null };
		writeFileSync(file, encodeCache(entry));
		expect(readCache(file)).toEqual(entry);
	});

	it("reads an absent or corrupt file as null", () => {
		expect(readCache(path.join(dir, "none.json.gz"))).toBeNull();
		const bad = path.join(dir, "bad.json.gz");
		writeFileSync(bad, "not gzip");
		expect(readCache(bad)).toBeNull();
	});
});
