// test/sim/chrome/offscreen.ts
/**
 * `chrome.offscreen`: at most one document. A second `createDocument` fails
 * like Chrome ("Only a single offscreen document may be created."), and
 * `closeDocument` without one fails with "No current offscreen document.".
 * `runtime.getContexts` (wired in `createSimulator`) reports the document as
 * an `OFFSCREEN_DOCUMENT` context while it exists.
 */

import type { Bus } from "@test/sim/contexts/bus";
import type { OffscreenDocumentRecord } from "@test/sim/types";

export const SINGLE_DOCUMENT_ERROR = "Only a single offscreen document may be created.";
export const NO_DOCUMENT_ERROR = "No current offscreen document.";

export function createOffscreenSubsystem(bus: Bus) {
	let document: OffscreenDocumentRecord | null = null;
	const history: OffscreenDocumentRecord[] = [];
	const onCreate = new Set<(doc: OffscreenDocumentRecord) => void>();
	const onClose = new Set<() => void>();

	const api = {
		Reason: {
			TESTING: "TESTING",
			AUDIO_PLAYBACK: "AUDIO_PLAYBACK",
			IFRAME_SCRIPTING: "IFRAME_SCRIPTING",
			DOM_SCRAPING: "DOM_SCRAPING",
			BLOBS: "BLOBS",
			DOM_PARSER: "DOM_PARSER",
			USER_MEDIA: "USER_MEDIA",
			DISPLAY_MEDIA: "DISPLAY_MEDIA",
			WEB_RTC: "WEB_RTC",
			CLIPBOARD: "CLIPBOARD",
			LOCAL_STORAGE: "LOCAL_STORAGE",
			WORKERS: "WORKERS",
			BATTERY_STATUS: "BATTERY_STATUS",
			MATCH_MEDIA: "MATCH_MEDIA",
			GEOLOCATION: "GEOLOCATION",
		},
		createDocument(params: chrome.offscreen.CreateParameters, callback?: () => void) {
			if (document) return bus.settle(callback, undefined, SINGLE_DOCUMENT_ERROR);
			document = {
				url: params.url,
				reasons: [...params.reasons],
				justification: params.justification,
				createdAt: bus.now(),
			};
			history.push(document);
			for (const l of [...onCreate]) l(document);
			return bus.settle(callback, undefined);
		},
		hasDocument(callback?: (result: boolean) => void) {
			return bus.settle(callback, document !== null);
		},
		closeDocument(callback?: () => void) {
			if (!document) return bus.settle(callback, undefined, NO_DOCUMENT_ERROR);
			document = null;
			for (const l of [...onClose]) l();
			return bus.settle(callback, undefined);
		},
	};

	return {
		api,
		/** The live document, if any. */
		document: (): OffscreenDocumentRecord | null => document,
		/** Every document ever created (including closed ones). */
		history: (): OffscreenDocumentRecord[] => [...history],
		hasDocument: (): boolean => document !== null,
		/** Test hooks fired on create/close (used by `bootOffscreenContext` wiring). */
		onCreate: (l: (doc: OffscreenDocumentRecord) => void): (() => void) => {
			onCreate.add(l);
			return () => void onCreate.delete(l);
		},
		onClose: (l: () => void): (() => void) => {
			onClose.add(l);
			return () => void onClose.delete(l);
		},
		/** Mark a document present without going through `createDocument` (context booters). */
		adopt(url: string): void {
			if (document) return;
			document = { url, reasons: ["WORKERS"], justification: "adopted by test", createdAt: bus.now() };
			history.push(document);
		},
		/** Drop the document without firing hooks (SW-restart style reset in tests). */
		reset(): void {
			document = null;
		},
	};
}

export type OffscreenSubsystem = ReturnType<typeof createOffscreenSubsystem>;
