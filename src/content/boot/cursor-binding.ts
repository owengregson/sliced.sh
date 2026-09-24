/**
 * The pointer and keyboard capture installed at `document_start`, before the page's own
 * listeners and long before the board exists: the cursor tracker and the in-page keybinds, plus
 * the ownership flags the input shield (`input-shield.ts`) sets once the boot completes.
 */

import {
	type CursorSample,
	type CursorTracker,
	createCursorTracker,
} from "@content/cursor-tracker";
import { installKeybinds } from "@content/keybinds";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import { sendTyped } from "@core/messaging/typed-messages";
import { DEFAULT_KEYBINDS, type Keybinds } from "@typedefs/settings";

export interface CursorBinding {
	tracker: CursorTracker;
	/** Where trusted samples go once the game port exists. */
	onSample?: (sample: CursorSample) => void;
	keybinds: Keybinds;
	exclusiveKeyboard: boolean;
	inputOwned: boolean;
	removeKeybinds: () => void;
}

export function createCursorBinding(win: Window): CursorBinding {
	// Install capture at document_start, before page listeners; the board may be parsed much later.
	const cursor: CursorBinding = {
		tracker: createCursorTracker({ window: win, onSample: (sample) => cursor.onSample?.(sample) }),
		keybinds: { ...DEFAULT_KEYBINDS, global: false },
		exclusiveKeyboard: false,
		inputOwned: false,
		removeKeybinds: () => {},
	};
	// Register keyboard capture before body/adapter initialization, just like pointer capture.
	// A page listener installed while the body is still loading must not swallow our shortcuts.
	cursor.removeKeybinds = installKeybinds(
		() => cursor.keybinds,
		(action) => {
			sendTyped({ type: MSG.CONTENT_KEYBIND, action }).catch((error: unknown) => {
				log.debug("content: keybind not delivered", error);
			});
		},
		{ window: win, exclusive: () => cursor.exclusiveKeyboard }
	);
	return cursor;
}
