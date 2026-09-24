import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeFiles, walkFiles } from "../../../scripts/lib/fs";

const dir = mkdtempSync(path.join(tmpdir(), "sl-lib-fs-"));
mkdirSync(path.join(dir, "a", "b"), { recursive: true });
writeFileSync(path.join(dir, "top.txt"), "top");
writeFileSync(path.join(dir, "a", "b", "deep.txt"), "deep");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("walkFiles", () => {
	it("lists every file as a posix path relative to the root", () => {
		expect(walkFiles(dir).sort()).toEqual(["a/b/deep.txt", "top.txt"]);
	});
});

describe("describeFiles", () => {
	it("describes each named file in the order given", async () => {
		const sha = (s: string) => createHash("sha256").update(s).digest("hex");
		expect(await describeFiles(dir, ["top.txt", "a/b/deep.txt"])).toEqual([
			{ name: "top.txt", bytes: 3, sha256: sha("top") },
			{ name: "a/b/deep.txt", bytes: 4, sha256: sha("deep") },
		]);
	});
});
