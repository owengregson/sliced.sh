// scripts/build/sounds.ts — build step `copy`, part 2: package only the sounds the runtime names.

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
	FORCED_MATE_SOUNDS,
	MOVE_RATING_SOUNDS,
	SOUNDS,
	SOUNDS_DIR,
} from "../../src/core/constants/sounds";

/** Keep source recordings intact; the generated package needs only clips the runtime names. */
export async function prunePackagedSounds(dist: string): Promise<string[]> {
	const dir = path.join(dist, SOUNDS_DIR);
	const required = new Set<string>([
		...Object.values(SOUNDS),
		...Object.values(MOVE_RATING_SOUNDS),
		FORCED_MATE_SOUNDS.file,
	]);
	const files = await readdir(dir);
	const present = new Set(files);
	for (const name of required)
		if (!present.has(name)) throw new Error(`package: registered sound ${name} is missing`);
	const obsolete = files.filter((name) => /\.(?:mp3|wav|ogg)$/i.test(name) && !required.has(name));
	for (const name of obsolete) await rm(path.join(dir, name));
	return obsolete.sort();
}
