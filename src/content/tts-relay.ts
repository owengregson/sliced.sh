/**
 * TTS relay (Task 21) — deliberately empty.
 *
 * Spoken moves are produced by the service worker through `chrome.tts`
 * (`src/service/tts.ts`), never in the page: the content script must not
 * touch the page's Web Speech API (a detectable signal, §13.3) and has no
 * `chrome.tts` access. The `speak` port command therefore reaches this
 * module only to be ignored; nothing is forwarded to the page or back.
 */

import type { GamePortCommand } from "@core/constants/messages";

export type SpeakCommand = Extract<GamePortCommand, { kind: "speak" }>;

/** Accept a `speak` command and do nothing with it. Returns `"ignored"` for the caller's bookkeeping. */
export function relaySpeak(_cmd: SpeakCommand): "ignored" {
	return "ignored";
}
