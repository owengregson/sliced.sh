/**
 * View 2 — Not on a supported site (Appendix F §4.2): board icon, copy, a ghost link to chess.com
 * and the note; on chess.com's own non-game pages (`pageKind` is not a live game) the copy changes
 * and the Play link deep-links to the play page. Links are shell `open-url` actions (refused
 * during a live game, §13.4).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { PLAY_URL, type UrlKey } from "../actions";
import { createEmptyState } from "../components/empty-state";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import type { View } from "../view";
import html from "./templates/unsupported.html?raw";

/** `true` on a chess.com page that is not a live game — the "this page isn't a game" variant. */
export function isNonGamePage(snapshot: PanelSnapshot): boolean {
	return snapshot.site !== null && snapshot.pageKind !== "live-game";
}

export const unsupportedView: View = {
	mount(ctx) {
		const el = instantiate(html);
		const empty = createEmptyState(el, {
			icon: "game.board",
			title: COPY.unsupported.title,
			note: COPY.unsupported.note,
		});
		let nonGame: boolean | null = null;

		function link(button: HTMLElement, url: UrlKey): void {
			button.dataset.action = "open-url";
			button.dataset.url = url;
		}

		function apply(next: boolean): void {
			if (next === nonGame) return;
			nonGame = next;
			if (!next) {
				empty.update({
					title: COPY.unsupported.title,
					body: COPY.unsupported.body,
					actions: [{ label: COPY.unsupportedView.chesscom, variant: "ghost", icon: "action.external" }],
				});
				link(part(empty.el, ".sl-empty__actions .sl-button"), "chesscom");
				return;
			}
			empty.update({
				title: COPY.nonGame.title,
				body: COPY.nonGame.body,
				actions: [{ label: COPY.unsupportedView.play, variant: "ghost", icon: "action.external" }],
			});
			link(part(empty.el, ".sl-empty__actions .sl-button"), PLAY_URL);
		}

		const unsubscribe = ctx.store.subscribe((snapshot) => apply(isNonGamePage(snapshot)));
		if (nonGame === null) apply(false);
		ctx.container.append(el);
		return () => {
			unsubscribe();
			empty.dispose();
			el.remove();
		};
	},
};
