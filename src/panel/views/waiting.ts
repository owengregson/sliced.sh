/**
 * View 3 — Waiting for a game (Appendix F §4.3, V2 §10.4/§13.4): neutral eval rail, site/engine
 * meta, the watching/reading status pulse, the detected opponent with the derived target Elo
 * (§13.6), the hold-to-arm auto-play toggle, a Settings link, the last-session strip and the
 * new-game link (only without auto-queue).
 *
 * Arming dispatches `PANEL_SET_AUTO_MOVE { tabId, armed: true }` at once — the SW attaches the
 * debugger now, before the game, so the infobar's layout shift never lands inside a move window —
 * and shows the §7.3 infobar explanation once per panel session. A pre-armed snapshot shows
 * "Armed for next game" and locks the toggle until a game starts. Strength / persona / timing /
 * execution live in Settings (Task 25); only the link is here.
 */

import { tabsQuery } from "@core/chrome/tabs";
import type { PanelSnapshot } from "@core/constants/messages";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { Site } from "@typedefs/game";
import type { UrlKey } from "../actions";
import { showBanner } from "../components/banner";
import { createButton } from "../components/button";
import { createEvalBar } from "../components/eval-bar";
import { createPill } from "../components/pill";
import { attachTooltip } from "../components/popover";
import { createToggle, type ToggleUpdate } from "../components/toggle";
import { COPY } from "../copy";
import { formatSeconds } from "../format";
import { instantiate, part } from "../template";
import type { View } from "../view";
import html from "./templates/waiting.html?raw";

export interface WaitingViewOptions {
	/** The game tab to arm (default: the active tab of the current window). */
	resolveTabId?: () => Promise<number | null>;
}

/** §7.3: the infobar explanation banner shows once per panel session. */
let debuggerBannerShown = false;

export function resetWaitingSession(): void {
	debuggerBannerShown = false;
}

async function activeTabId(): Promise<number | null> {
	const tabs = await tabsQuery({ active: true, currentWindow: true });
	return tabs[0]?.id ?? null;
}

const PLAY_URL: Readonly<Record<Site, UrlKey>> = {
	chesscom: "chesscomPlay",
	lichess: "lichessLobby",
};

function engineText(snapshot: PanelSnapshot): string {
	switch (snapshot.engine.state) {
		case "ready":
		case "searching":
			return COPY.waiting.engineReady;
		case "crashed":
			return COPY.waitingView.engineStopped;
		default:
			return COPY.waiting.engineLoading;
	}
}

export function createWaitingView(options: WaitingViewOptions = {}): View {
	const resolveTabId = options.resolveTabId ?? activeTabId;
	return {
		mount(ctx) {
			const el = instantiate(html);
			part(el, ".sl-waiting__title").textContent = COPY.waiting.title;
			part(el, ".sl-waiting__opponent-label").textContent = COPY.waitingView.opponent;
			part(el, ".sl-waiting__session-label").textContent = COPY.waitingView.lastSession;
			const meta = part(el, ".sl-waiting__meta");
			const dot = part(el, ".sl-waiting__dot");
			const statusText = part(el, ".sl-waiting__status-text");
			const botHost = part(el, ".sl-waiting__bot");
			const opponentName = part(el, ".sl-waiting__opponent-name");
			const opponentRating = part(el, ".sl-waiting__opponent-rating");
			const target = part(el, ".sl-waiting__target");
			const session = part(el, ".sl-waiting__session");
			const sessionStrip = part(el, ".sl-waiting__session-strip");
			const newGameHost = part(el, ".sl-waiting__newgame");

			const rail = createEvalBar(part(el, ".sl-waiting__rail"));
			rail.update({ neutral: true });
			const bot = createPill(botHost, {
				variant: "locked",
				icon: "engine.nnue",
				text: COPY.waitingView.bot,
			});

			let tabId: number | null = null;
			const tabReady = resolveTabId().then(
				(id) => {
					if (!ctx.signal.aborted) tabId = id;
					return id;
				},
				(error: unknown) => {
					log.warn("waiting: could not resolve the game tab", { error });
					return null;
				}
			);

			function send(id: number | null, armed: boolean): void {
				if (ctx.signal.aborted) return;
				if (id === null) {
					log.warn("waiting: no game tab to arm");
					toggle.update({ checked: false });
					return;
				}
				ctx.store
					.dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: id, armed })
					.catch((error: unknown) => {
						log.warn("waiting: PANEL_SET_AUTO_MOVE failed", { armed, error });
						if (!ctx.signal.aborted) toggle.update({ checked: !armed });
					});
			}

			function setArmed(armed: boolean): void {
				if (tabId !== null) send(tabId, armed);
				else void tabReady.then((id) => send(id, armed));
				// "Armed for next game" and the lock follow the SW's `armed: true` snapshot: touching
				// the toggle here would let the click that ends the hold through as a disarm.
				if (!armed || debuggerBannerShown) return;
				debuggerBannerShown = true;
				showBanner("warn", COPY.banner.debugger, [{ label: COPY.banner.gotIt, onClick: () => {} }], {
					key: "debugger",
				});
			}

			const toggle = createToggle(part(el, ".sl-waiting__toggle"), {
				label: COPY.toggle.autoplay,
				icon: "toggle.autoplay",
				armed: true,
				checked: ctx.snapshot?.autoMove.armed ?? false,
				locked: ctx.snapshot?.autoMove.armed ?? false,
				hint: ctx.snapshot?.autoMove.armed ? COPY.waiting.preArmed : COPY.waiting.autoplayTooltip,
				onChange: setArmed,
			});
			const detachTooltip = attachTooltip(toggle.el, COPY.waiting.autoplayTooltip);

			const settings = createButton(part(el, ".sl-waiting__settings"), {
				label: COPY.nav.settings,
				variant: "ghost",
				size: "sm",
				icon: "nav.settings",
			});
			settings.el.dataset.action = "view-switch";
			settings.el.dataset.tab = "settings";
			const newGame = createButton(newGameHost, {
				label: COPY.waitingView.newGame,
				variant: "ghost",
				icon: "action.external",
			});
			newGame.el.dataset.action = "open-url";

			let renderedLocked: boolean | null = null;
			let renderedHint: string | null = null;

			function render(snapshot: PanelSnapshot): void {
				const site = snapshot.site ?? snapshot.session.site;
				meta.textContent = COPY.waiting.meta(
					site ? COPY.waitingView.sites[site] : COPY.brand.name,
					engineText(snapshot)
				);
				const reading = snapshot.session.state === "idle";
				dot.dataset.state = reading ? "warn" : "ok";
				statusText.textContent = reading ? COPY.waiting.reading : COPY.waiting.watching;

				const opponent = snapshot.opponent;
				opponentName.textContent = opponent ? opponent.name : COPY.waitingView.noOpponent;
				botHost.hidden = !opponent?.isBot;
				opponentRating.textContent =
					opponent?.ratingEstimate === null || opponent?.ratingEstimate === undefined
						? COPY.waitingView.ratingUnknown
						: COPY.waitingView.rating(opponent.ratingEstimate);
				target.textContent = COPY.waitingView.target(
					opponent?.derivedTargetElo ?? snapshot.settings.strength.targetElo
				);

				// Patch only what differs from the toggle's own state: a snapshot that agrees with it
				// must not touch the component (an update would cancel a hold in progress).
				const armed = snapshot.autoMove.armed;
				const hint = armed ? COPY.waiting.preArmed : COPY.waiting.autoplayTooltip;
				const patch: ToggleUpdate = {};
				if (toggle.checked !== armed) patch.checked = armed;
				if (renderedLocked !== armed) patch.locked = armed;
				if (renderedHint !== hint) patch.hint = hint;
				if (Object.keys(patch).length > 0) toggle.update(patch);
				renderedLocked = armed;
				renderedHint = hint;

				const stats = snapshot.stats;
				session.hidden = stats.games === 0;
				sessionStrip.textContent = COPY.waitingView.session(
					stats.games,
					stats.moves,
					formatSeconds(stats.avgThinkMs)
				);
				newGameHost.hidden = snapshot.settings.automation.autoQueue || site === null;
				if (site) newGame.el.dataset.url = PLAY_URL[site];
			}

			const unsubscribe = ctx.store.subscribe(render);
			ctx.container.append(el);

			return () => {
				unsubscribe();
				detachTooltip();
				toggle.dispose();
				settings.dispose();
				newGame.dispose();
				bot.dispose();
				rail.dispose();
				el.remove();
			};
		},
	};
}

export const waitingView: View = createWaitingView();
