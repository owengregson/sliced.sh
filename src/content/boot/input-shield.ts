/**
 * The input shield: while the hand owns the input or its mirror is drawn, the page's keyboard is
 * held exclusive and the tracker marks the pointer virtual.
 *
 * The page-kind gate (2026-09-13): the shield, keyboard exclusivity and the mirror exist on game
 * pages only (`GAME_PAGE_KINDS`). Anywhere else the real mouse keeps the page: ownership is
 * answered as not owned, a `cursorTo` draws nothing, and leaving a game page by SPA navigation
 * releases whatever was up.
 */

import type { PageBridge } from "@content/adapters/adapter";
import { isGamePage } from "@content/adapters/page-kind";
import { createVirtualCursor, type VirtualCursor } from "@content/virtual-cursor";
import type { PageKind } from "@typedefs/game";
import type { CursorBinding } from "./cursor-binding";

export interface InputShield {
	/** The mirror of the hand's own pointer. */
	readonly virtualCursor: VirtualCursor;
	/** A game page — or the post-game page while queue input is on. */
	gamePage(): boolean;
	setQueueInput(on: boolean): void;
	/** The worker's `inputOwnership`; not a game page answers as not owned, whatever it believes. */
	setOwned(owned: boolean): void;
	/** Unlock: drop the hand's ownership and erase the mirror. */
	release(): void;
	/** Release, if the page is no longer a game page and anything is up. */
	releaseIfOffGamePage(): void;
}

export function createInputShield(
	binding: CursorBinding,
	bridge: PageBridge,
	pageKind: () => PageKind
): InputShield {
	const cursor = binding.tracker;
	let queueInput = false;
	const gamePage = (): boolean =>
		isGamePage(pageKind()) || (pageKind() === "live-postgame" && queueInput);
	/** The shield is up while the mirror is drawn (glide included) or the hand owns the input. */
	const syncExclusive = (): void => {
		binding.exclusiveKeyboard = binding.inputOwned || virtualCursor.shown();
		cursor.setVirtualActive(binding.exclusiveKeyboard);
	};
	// Fix D: the mirror of the hand's own pointer. Drawn by the MAIN-world bridge (§13.3), driven
	// only by what the service worker dispatched — never by a pointer event read here. The unlock
	// glide's target is the one exception in spirit: it *reads* the tracker's latest real sample,
	// but only to draw the arrow towards it once, at the moment the mirror is being erased anyway.
	const virtualCursor = createVirtualCursor(bridge, {
		onVisibilityChange: syncExclusive,
		allowed: gamePage,
		realPosition: () => {
			const s = cursor.latest();
			return s ? { x: s.x, y: s.y } : null;
		},
	});
	/**
	 * Every unlock goes through here: the hand's ownership is dropped and the mirror is erased —
	 * after the glide to the real pointer, when one is possible. The shield stays up for the
	 * glide (the mirror counts as shown) and drops from the visibility callback when it ends; when
	 * no glide runs and the hide could not even leave (no page side to erase), the shield is
	 * lowered anyway — a mirror nobody can move must not keep the page locked with no owner.
	 */
	const release = (): void => {
		binding.inputOwned = false;
		virtualCursor.apply({ kind: "cursorHide" });
		if (virtualCursor.gliding()) syncExclusive();
		else {
			binding.exclusiveKeyboard = false;
			cursor.setVirtualActive(false);
		}
	};
	return {
		virtualCursor,
		gamePage,
		setQueueInput(on) {
			queueInput = on;
		},
		setOwned(owned) {
			binding.inputOwned = owned && gamePage();
			syncExclusive();
		},
		release,
		releaseIfOffGamePage() {
			if (!gamePage() && (binding.inputOwned || virtualCursor.shown())) release();
		},
	};
}
