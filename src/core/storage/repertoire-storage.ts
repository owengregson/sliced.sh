/**
 * `LOCAL_KEYS.repertoire` persistence (H14.1, 2026-09-13): the per-profile opening-repertoire
 * keys are created once — the first time the book is asked — and read back for every game after,
 * so the same first moves recur across games. `resetRepertoireKeys` forgets them (a new
 * "player"); the next read creates a fresh pair.
 */

import { chromeLocalGet, chromeLocalRemove, chromeLocalSet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import {
	isRepertoireKeys,
	makeRepertoireKeys,
	type RepertoireKeys,
} from "@core/strength/book/repertoire";
import { errorMessage } from "@core/util/errors";

/** Two uniform 32-bit values from the platform's CSPRNG (`Math.random` is not the seed source). */
function randomPair(): [number, number] {
	const out = new Uint32Array(2);
	globalThis.crypto.getRandomValues(out);
	return [out[0] ?? 0, out[1] ?? 0];
}

/**
 * The stored keys, or a newly created and stored pair. A stored value with the wrong shape is
 * replaced (it would otherwise never draw a book move again). Never throws: a storage failure is
 * logged and answers `null`, so the book falls back to its per-game draw for this session.
 */
export async function loadRepertoireKeys(
	now: () => number = Date.now
): Promise<RepertoireKeys | null> {
	try {
		const stored = await chromeLocalGet(LOCAL_KEYS.repertoire);
		if (isRepertoireKeys(stored)) return stored;
		const created = makeRepertoireKeys(randomPair(), now());
		await chromeLocalSet(LOCAL_KEYS.repertoire, created);
		log.info("repertoire: created the opening repertoire keys", { createdAt: created.createdAt });
		return created;
	} catch (error) {
		log.debug("repertoire: keys unavailable, per-game book draws", { error: errorMessage(error) });
		return null;
	}
}

/** Forget the repertoire; the next `loadRepertoireKeys` creates a new pair. */
export function resetRepertoireKeys(): Promise<void> {
	return chromeLocalRemove(LOCAL_KEYS.repertoire);
}
