/**
 * §13.6 session statistics, persisted under one storage key for the whole worker.
 */

import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { SessionStats } from "@typedefs/game";
import { EMPTY_STATS } from "../stats";

/**
 * `LOCAL_KEYS.sessionStats` is one key for the whole worker, and every fold is a
 * read-modify-write: a `recordMove` racing a `finishGame` (or a second tab's session) would
 * otherwise drop one of them. Every fold in the worker goes through this one chain.
 */
let statsChain: Promise<void> = Promise.resolve();

export function queueStatsWrite(fold: (stats: SessionStats) => SessionStats): Promise<void> {
	statsChain = statsChain.then(async () => {
		try {
			const stored = (await chromeLocalGet(LOCAL_KEYS.sessionStats)) as SessionStats | undefined;
			await chromeLocalSet(LOCAL_KEYS.sessionStats, fold(stored ?? { ...EMPTY_STATS }));
		} catch (error) {
			log.debug("game-session: session stats not written", { error: errorMessage(error) });
		}
	});
	return statsChain;
}
