/**
 * `document_start` path: the manifest injects the content script before `<body>` exists. The
 * handle returned here answers the page kind from the URL, has no adapter and sends nothing, and
 * completes the boot once the body appears (`DOMContentLoaded` / `readystatechange` / a poll),
 * so the adapter never sees a body-less document.
 */

import { pageKindFromPath } from "@content/adapters/page-kind";
import { TIMINGS } from "@core/constants/timings";
import type { Site } from "@typedefs/game";
import type { CursorBinding } from "./cursor-binding";
import type { ContentHandle } from "./types";

export function deferUntilBody(
	site: Site,
	win: Window,
	doc: Document,
	cursorBinding: CursorBinding,
	boot: () => ContentHandle
): ContentHandle {
	let inner: ContentHandle | null = null;
	let done = false;
	const stop = (): void => {
		if (done) return;
		done = true;
		clearInterval(timer);
		doc.removeEventListener("DOMContentLoaded", tryBoot, true);
		doc.removeEventListener("readystatechange", tryBoot, true);
	};
	const tryBoot = (): void => {
		if (done || !doc.body) return;
		stop();
		inner = boot();
	};
	doc.addEventListener("DOMContentLoaded", tryBoot, true);
	doc.addEventListener("readystatechange", tryBoot, true);
	const timer = setInterval(tryBoot, TIMINGS.contentReadyPollMs);
	return {
		site,
		pageKind: () => inner?.pageKind() ?? pageKindFromPath(win.location.pathname),
		adapter: () => inner?.adapter() ?? null,
		dispose() {
			stop();
			if (inner) inner.dispose();
			else {
				cursorBinding.tracker.dispose();
				cursorBinding.removeKeybinds();
			}
		},
	};
}
