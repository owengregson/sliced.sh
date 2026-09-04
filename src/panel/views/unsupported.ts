/**
 * View 2 — Not on a supported site (Appendix F §4.2): board icon, copy, two ghost site links and
 * the note; on a supported site's non-game page (`pageKind` is not a live game) the copy changes
 * and a single Play link deep-links to the site's play page. Links are shell `open-url` actions
 * (refused during a live game, §13.4).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import type { UrlKey } from "../actions";
import { createEmptyState } from "../components/empty-state";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import type { View } from "../view";
import html from "./templates/unsupported.html?raw";

type Variant = "unsupported" | "chesscom" | "lichess";

export function unsupportedVariant(snapshot: PanelSnapshot): Variant {
	if (snapshot.site === null || snapshot.pageKind === "live-game") return "unsupported";
	return snapshot.site;
}

const PLAY_URL: Readonly<Record<"chesscom" | "lichess", UrlKey>> = {
	chesscom: "chesscomPlay",
	lichess: "lichessLobby",
};

export const unsupportedView: View = {
	mount(ctx) {
		const el = instantiate(html);
		const empty = createEmptyState(el, {
			icon: "game.board",
			title: COPY.unsupported.title,
			note: COPY.unsupported.note,
		});
		let variant: Variant | null = null;

		function link(button: HTMLElement, url: UrlKey): void {
			button.dataset.action = "open-url";
			button.dataset.url = url;
		}

		function apply(next: Variant): void {
			if (next === variant) return;
			variant = next;
			if (next === "unsupported") {
				empty.update({
					title: COPY.unsupported.title,
					body: COPY.unsupported.body,
					actions: [
						{ label: COPY.unsupportedView.chesscom, variant: "ghost", icon: "action.external" },
						{ label: COPY.unsupportedView.lichess, variant: "ghost", icon: "action.external" },
					],
				});
				const [chesscom, lichess] = empty.el.querySelectorAll<HTMLElement>(
					".sl-empty__actions .sl-button"
				);
				if (chesscom) link(chesscom, "chesscom");
				if (lichess) link(lichess, "lichess");
				return;
			}
			empty.update({
				title: COPY.nonGame.title,
				body: COPY.nonGame.body,
				actions: [{ label: COPY.unsupportedView.play, variant: "ghost", icon: "action.external" }],
			});
			link(part(empty.el, ".sl-empty__actions .sl-button"), PLAY_URL[next]);
		}

		const unsubscribe = ctx.store.subscribe((snapshot) => apply(unsupportedVariant(snapshot)));
		if (variant === null) apply("unsupported");
		ctx.container.append(el);
		return () => {
			unsubscribe();
			empty.dispose();
			el.remove();
		};
	},
};
