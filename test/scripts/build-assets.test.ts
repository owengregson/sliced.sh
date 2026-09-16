import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FORCED_MATE_SOUNDS, MOVE_RATING_SOUNDS, SOUNDS, SOUNDS_DIR } from "@core/constants/sounds";
import { prunePackagedSounds } from "../../scripts/build";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function soundTree(): Promise<{ root: string; dir: string; clips: string[] }> {
	const root = await mkdtemp(path.join(tmpdir(), "sliced-package-sounds-"));
	roots.push(root);
	const dir = path.join(root, SOUNDS_DIR);
	await mkdir(dir, { recursive: true });
	const clips = [
		...Object.values(SOUNDS),
		...Object.values(MOVE_RATING_SOUNDS),
		FORCED_MATE_SOUNDS.file,
	];
	for (const clip of clips) await writeFile(path.join(dir, clip), `original ${clip}`);
	return { root, dir, clips };
}

describe("packaged sounds", () => {
	it("excludes retired recordings, preserves registered clips verbatim and keeps notices", async () => {
		const { root, dir, clips } = await soundTree();
		for (const stale of ["forced_1.mp3", "forced_3.mp3", "best_v2.mp3", "preview.wav"])
			await writeFile(path.join(dir, stale), "unused");
		await writeFile(path.join(dir, "LICENSE.txt"), "notice");
		expect(await prunePackagedSounds(root)).toEqual([
			"best_v2.mp3",
			"forced_1.mp3",
			"forced_3.mp3",
			"preview.wav",
		]);
		expect((await readdir(dir)).sort()).toEqual([...clips, "LICENSE.txt"].sort());
		for (const clip of clips)
			expect(await readFile(path.join(dir, clip), "utf8")).toBe(`original ${clip}`);
		expect(await readFile(path.join(dir, "LICENSE.txt"), "utf8")).toBe("notice");
		expect(await prunePackagedSounds(root)).toEqual([]);
	});

	it("fails before pruning if the current forced-mate recording is missing", async () => {
		const { root, dir } = await soundTree();
		await rm(path.join(dir, FORCED_MATE_SOUNDS.file));
		await writeFile(path.join(dir, "forced_3.mp3"), "old recording");
		await expect(prunePackagedSounds(root)).rejects.toThrow("forced.mp3 is missing");
		expect(await readFile(path.join(dir, "forced_3.mp3"), "utf8")).toBe("old recording");
	});
});
