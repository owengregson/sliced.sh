// test/panel/views/waiting.test.ts — Appendix F §4.3 (V2): opponent + derived target Elo, the
// hold-to-arm control dispatching PANEL_SET_AUTO_MOVE at arm time with the infobar explanation,
// the pre-armed lock, session strip, Settings link and the new-game link.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MSG, type PanelSnapshot, UI_TIMINGS } from "@core/constants";
import { clearBanners, currentBannerKind, mountBannerSlot } from "@panel/components/banner";
import { COPY } from "@panel/copy";
import { resetWaitingSession, waitingView } from "@panel/views/waiting";
import { bootPanelDom, click, mount, type PanelDom, pointer } from "../dom";
import { makeSnapshot } from "../fixtures";
import { type FakeStore, fakeStore, makeContext } from "./fake-store";

let dom: PanelDom;
let cleanup: (() => void) | null = null;
let store: FakeStore;
let container: HTMLElement;
let bannerSlot: HTMLElement;
let tabId: number;

beforeEach(async () => {
	dom = await bootPanelDom();
	resetWaitingSession();
	tabId = dom.sim.openTab("https://lichess.org/", { active: true }).tabId;
	container = mount(document.createElement("main"));
	bannerSlot = mount(document.createElement("div"));
	mountBannerSlot(bannerSlot);
});
afterEach(async () => {
	cleanup?.();
	cleanup = null;
	clearBanners();
	await dom.teardown();
});

function withOpponent(snapshot: PanelSnapshot, opponent: PanelSnapshot["opponent"]): PanelSnapshot {
	return opponent ? { ...snapshot, opponent } : snapshot;
}

async function mountWaiting(snapshot: PanelSnapshot): Promise<void> {
	store = fakeStore(snapshot);
	cleanup = await waitingView.mount(makeContext(container, store));
	await dom.tick(0); // the active tab is resolved through `tabsQuery`
}

const text = (selector: string): string =>
	container.querySelector(selector)?.textContent?.trim() ?? "";
const toggle = (): HTMLButtonElement => {
	const el = container.querySelector<HTMLButtonElement>(".sl-toggle");
	if (!el) throw new Error("no toggle");
	return el;
};

describe("waitingView", () => {
	it("shows the detected opponent and the derived target Elo", async () => {
		await mountWaiting(
			withOpponent(makeSnapshot(), {
				isBot: false,
				name: "MagnusFan",
				ratingEstimate: 1480,
				derivedTargetElo: 1450,
			})
		);
		expect(container.querySelector("[data-view=waiting]")).not.toBeNull();
		expect(text(".sl-view__title")).toBe(COPY.waiting.title);
		expect(text(".sl-waiting__meta")).toBe(
			COPY.waiting.meta(COPY.waitingView.sites.lichess, COPY.waiting.engineReady)
		);
		expect(text(".sl-waiting__status-text")).toBe(COPY.waiting.watching);
		expect(container.querySelector<HTMLElement>(".sl-waiting__dot")?.dataset.state).toBe("ok");
		expect(container.querySelector(".sl-evalbar--neutral")).not.toBeNull();
		expect(text(".sl-waiting__opponent-label")).toBe(COPY.waitingView.opponent);
		expect(text(".sl-waiting__opponent-name")).toBe("MagnusFan");
		expect(container.querySelector<HTMLElement>(".sl-waiting__bot")?.hidden).toBe(true);
		expect(text(".sl-waiting__opponent-rating")).toBe(COPY.waitingView.rating(1480));
		expect(text(".sl-waiting__target")).toBe(COPY.waitingView.target(1450));
		expect(document.activeElement).toBe(document.body);

		// A bot with an unknown rating (§7.4a): badge + "opponent rating unknown".
		store.emit(
			withOpponent(makeSnapshot(), {
				isBot: true,
				name: "Maia 1",
				ratingEstimate: null,
				derivedTargetElo: 1300,
			})
		);
		expect(container.querySelector<HTMLElement>(".sl-waiting__bot")?.hidden).toBe(false);
		expect(text(".sl-waiting__bot")).toBe(COPY.waitingView.bot);
		expect(text(".sl-waiting__opponent-rating")).toBe(COPY.waitingView.ratingUnknown);
		expect(text(".sl-waiting__target")).toBe(COPY.waitingView.target(1300));

		// No opponent yet: the target falls back to the strength setting.
		const idle = makeSnapshot({ state: "idle" });
		store.emit(idle);
		expect(text(".sl-waiting__opponent-name")).toBe(COPY.waitingView.noOpponent);
		expect(text(".sl-waiting__target")).toBe(
			COPY.waitingView.target(idle.settings.strength.targetElo)
		);
		expect(text(".sl-waiting__status-text")).toBe(COPY.waiting.reading);
		expect(container.querySelector<HTMLElement>(".sl-waiting__dot")?.dataset.state).toBe("warn");
	});

	it("hold-to-arm dispatches PANEL_SET_AUTO_MOVE at arm time and shows the infobar explanation", async () => {
		await mountWaiting(makeSnapshot());
		const el = toggle();
		expect(el.classList.contains("sl-toggle--armable")).toBe(true);
		expect(el.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.autoplay);
		expect(el.querySelector(".sl-toggle__icon")?.getAttribute("data-icon")).toBe("toggle.autoplay");
		expect(el.classList.contains("sl-toggle--locked")).toBe(false);
		pointer(el, "pointerdown", { pointerId: 1, isPrimary: true });
		await dom.tick(UI_TIMINGS.armHoldMs - 1);
		expect(store.dispatched).toEqual([]);
		await dom.tick(1);
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true }]);
		expect(el.getAttribute("aria-checked")).toBe("true");
		expect(el.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.armed);
		expect(currentBannerKind()).toBe("warn");
		const banner = bannerSlot.querySelector(".sl-banner");
		expect(banner?.querySelector(".sl-banner__text")?.textContent).toBe(COPY.banner.debugger);
		expect(banner?.querySelector(".sl-button")?.textContent?.trim()).toBe(COPY.banner.gotIt);
		pointer(el, "pointerup", { pointerId: 1, isPrimary: true });
		click(el);
		expect(store.dispatched).toHaveLength(1);

		// The SW confirms: "Armed for next game", and the toggle locks until a game starts.
		store.emit(makeSnapshot({ armed: true }));
		expect(el.querySelector(".sl-toggle__hint")?.textContent).toBe(COPY.waiting.preArmed);
		expect(el.classList.contains("sl-toggle--locked")).toBe(true);
		expect(el.querySelector(".sl-toggle__lock")?.hasAttribute("hidden")).toBe(false);
		expect(el.getAttribute("aria-checked")).toBe("true");
		click(el);
		expect(store.dispatched).toHaveLength(1);
	});

	it("pre-armed on mount: Armed for next game, locked, tooltip copy; the banner shows once per session", async () => {
		await mountWaiting(makeSnapshot({ armed: true }));
		const el = toggle();
		expect(el.getAttribute("aria-checked")).toBe("true");
		expect(el.classList.contains("sl-toggle--armed")).toBe(true);
		expect(el.classList.contains("sl-toggle--locked")).toBe(true);
		expect(el.querySelector(".sl-toggle__hint")?.textContent).toBe(COPY.waiting.preArmed);
		expect(currentBannerKind()).toBeNull();
		// Disarmed by the SW (Shift+A): the toggle opens up again with the default hint.
		store.emit(makeSnapshot());
		expect(el.classList.contains("sl-toggle--locked")).toBe(false);
		expect(el.getAttribute("aria-checked")).toBe("false");
		expect(el.querySelector(".sl-toggle__hint")?.textContent).toBe(COPY.waiting.autoplayTooltip);
		// Hover tooltip; its timer is cleared by cleanup.
		pointer(el, "pointerenter");
		await dom.tick(UI_TIMINGS.tooltipDelayMs);
		expect(document.querySelector(".sl-popover--tooltip")?.textContent).toBe(
			COPY.waiting.autoplayTooltip
		);
		pointer(el, "pointerleave");
		await dom.tick(0);
		pointer(el, "pointerenter");
		cleanup?.();
		cleanup = null;
		await dom.tick(UI_TIMINGS.tooltipDelayMs * 2);
		expect(document.querySelector(".sl-popover--tooltip")).toBeNull();
		expect(container.children).toHaveLength(0);
	});

	it("arming a second time in the session does not repeat the banner", async () => {
		await mountWaiting(makeSnapshot());
		pointer(toggle(), "pointerdown", { pointerId: 1, isPrimary: true });
		await dom.tick(UI_TIMINGS.armHoldMs);
		expect(currentBannerKind()).toBe("warn");
		clearBanners();
		store.emit(makeSnapshot()); // disarmed again
		pointer(toggle(), "pointerdown", { pointerId: 2, isPrimary: true });
		await dom.tick(UI_TIMINGS.armHoldMs);
		expect(store.dispatched).toHaveLength(2);
		expect(currentBannerKind()).toBeNull();
	});

	it("Settings link, last-session strip and the new-game link (only without auto-queue)", async () => {
		const snapshot = makeSnapshot();
		snapshot.stats = { games: 6, moves: 180, avgThinkMs: 3140 };
		await mountWaiting(snapshot);
		const settings = container.querySelector<HTMLElement>(".sl-waiting__settings .sl-button");
		expect(settings?.textContent?.trim()).toBe(COPY.nav.settings);
		expect(settings?.dataset.action).toBe("view-switch");
		expect(settings?.dataset.tab).toBe("settings");
		expect(text(".sl-waiting__session-label")).toBe(COPY.waitingView.lastSession);
		expect(text(".sl-waiting__session-strip")).toBe(COPY.waitingView.session(6, 180, "3.1"));
		const newGame = container.querySelector<HTMLElement>(".sl-waiting__newgame .sl-button");
		expect(newGame?.textContent?.trim()).toBe(COPY.waitingView.newGame);
		expect(newGame?.dataset.action).toBe("open-url");
		expect(newGame?.dataset.url).toBe("lichessLobby");
		expect(container.querySelector<HTMLElement>(".sl-waiting__newgame")?.hidden).toBe(false);

		const queued = makeSnapshot({
			site: "chesscom",
			settings: { automation: { ...snapshot.settings.automation, autoQueue: true } },
		});
		store.emit(queued);
		expect(container.querySelector<HTMLElement>(".sl-waiting__newgame")?.hidden).toBe(true);
		expect(container.querySelector<HTMLElement>(".sl-waiting__session")?.hidden).toBe(true);
		expect(text(".sl-waiting__meta")).toBe(
			COPY.waiting.meta(COPY.waitingView.sites.chesscom, COPY.waiting.engineReady)
		);
	});
});
