/**
 * ISOLATED-world content script entry (Task 21, §3.4a, §13.4, V2.1).
 *
 * `startContent()` installs pointer and keyboard capture at once (`boot/cursor-binding.ts`), then
 * boots the rest (`boot/boot-content.ts`, the composition root) — immediately when `<body>`
 * exists, else once it appears (`boot/deferred-boot.ts`: the manifest injects this script at
 * `document_start`). The parts under `boot/`:
 *   - `game-feed.ts` / `opponent-poll.ts` / `page-state.ts` — what the worker is told about the
 *     page and its game;
 *   - `command-router.ts` — every command the worker sends, to the part that owns it;
 *   - `responders.ts` — the executor's board reads (`observeMove`, `geometry`, `boardCheck`,
 *     `cursorProbe`);
 *   - `control-reads.ts` — new game / resign / rematch discovery;
 *   - `input-shield.ts` — the pointer mirror and keyboard exclusivity, on game pages only;
 *   - `navigation.ts` — `popstate` and `location.href` re-detection.
 */

import { detectSite } from "@content/site-detect";
import { bootContent } from "./boot/boot-content";
import { createCursorBinding } from "./boot/cursor-binding";
import { deferUntilBody } from "./boot/deferred-boot";
import type { ContentHandle, ContentOptions } from "./boot/types";

export type { ContentHandle, ContentOptions } from "./boot/types";

/** Boot the content script for the current page; `null` when the host is not a supported site. */
export function startContent(options: ContentOptions = {}): ContentHandle | null {
	const win = options.window ?? window;
	const doc = options.document ?? document;
	const site = detectSite(win.location.hostname);
	if (!site) return null;
	const cursor = createCursorBinding(win);
	const boot = (): ContentHandle => bootContent(site, win, doc, options, cursor);
	if (doc.body) return boot();
	return deferUntilBody(site, win, doc, cursor, boot);
}

let current: ContentHandle | null = null;

/** The handle of the auto-booted content script (bundle entry), if any. */
export function currentContent(): ContentHandle | null {
	return current;
}

// Bundle entry: boot once on a supported page (the guard keeps test imports inert).
if (typeof window !== "undefined" && typeof document !== "undefined" && current === null) {
	current = startContent();
}
