/**
 * Single offscreen document for the engine (Appendix B §3). `ensureOffscreen`
 * dedupes concurrent callers within one SW lifetime, checks
 * `runtime.getContexts` first (the authoritative existence check on
 * Chrome 116+), and tolerates the "already exists" race with a previous SW
 * instance. `closeOffscreen` is a no-op without a document.
 */

import { offscreenClose, offscreenEnsure } from "@core/chrome/offscreen";
import { runtimeGetContexts } from "@core/chrome/runtime";
import { log } from "@core/logger";
import { dedupeAsync } from "@core/util/dedupe-async";

export const OFFSCREEN_PAGE_PATH = "pages/offscreen.html";
const OFFSCREEN_JUSTIFICATION = "Runs the chess engine in a Web Worker with SharedArrayBuffer";
const ALREADY_EXISTS = /only a single offscreen document/i;

async function create(): Promise<void> {
	try {
		const created = await offscreenEnsure({
			url: OFFSCREEN_PAGE_PATH,
			reasons: ["WORKERS"],
			justification: OFFSCREEN_JUSTIFICATION,
		});
		if (created) log.debug("offscreen: document created");
	} catch (error) {
		if (error instanceof Error && ALREADY_EXISTS.test(error.message)) return;
		throw error;
	}
}

/** Create the offscreen document if none exists; concurrent callers share one attempt. */
export const ensureOffscreen: () => Promise<void> = dedupeAsync(create);

export async function closeOffscreen(): Promise<void> {
	const existing = await runtimeGetContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
	if (existing.length === 0) return;
	try {
		await offscreenClose();
	} catch (error) {
		log.debug("offscreen: close failed", error);
	}
}
