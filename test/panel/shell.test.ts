// test/panel/shell.test.ts — the shell as a projection of snapshots: top bar / view switch,
// `Alt+1/2/3`, hands-off mode (§13.4) with its banner and disabled controls, update interrupt.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_KEYS, type PanelSnapshot } from "@core/constants";
import { currentBannerKind } from "@panel/components/banner";
import { openPopover } from "@panel/components/popover";
import { createToggle, type ToggleHandle } from "@panel/components/toggle";
import { COPY } from "@panel/copy";
import { bootShell, type PanelShell } from "@panel/shell";
import type { PanelStore } from "@panel/store";
import type { View } from "@panel/view";
import { bootPanelDom, click, key, type PanelDom } from "./dom";
import { makeSnapshot } from "./fixtures";

interface FakeStore extends PanelStore {
	emit(snapshot: PanelSnapshot): void;
}

function fakeStore(): FakeStore {
	let snapshot: PanelSnapshot | null = null;
	const subs = new Set<(s: PanelSnapshot) => void>();
	return {
		get snapshot() {
			return snapshot;
		},
		connected: true,
		subscribe(cb) {
			subs.add(cb);
			if (snapshot) cb(snapshot);
			return () => void subs.delete(cb);
		},
		onPortMessage: () => () => {},
		dispatch: () => Promise.reject(new Error("not wired")),
		refresh() {},
		dispose() {},
		emit(next) {
			snapshot = next;
			for (const cb of subs) cb(next);
		},
	};
}

let dom: PanelDom;
let shell: PanelShell | null = null;
let store: FakeStore;

beforeEach(async () => {
	dom = await bootPanelDom();
	store = fakeStore();
});
afterEach(async () => {
	shell?.dispose();
	shell = null;
	await dom.teardown();
});

const app = (): HTMLElement => {
	const el = document.getElementById("app");
	if (!el) throw new Error("no #app");
	return el;
};
const mountedView = (): string | undefined =>
	app().querySelector<HTMLElement>(".sl-app__content > [data-view]")?.dataset.view;

describe("bootShell", () => {
	it("renders the shell chrome, hides the top bar on login, and follows snapshots", async () => {
		shell = bootShell(app(), { store });
		expect(app().classList.contains("sl-app")).toBe(true);
		expect(app().querySelector(".sl-topbar")).not.toBeNull();
		expect(app().querySelector(".sl-topbar__wordmark")?.textContent).toBe(COPY.brand.name);
		expect(app().querySelector(".sl-segment[role=tablist]")).not.toBeNull();
		expect(app().querySelectorAll(".sl-segment__item")).toHaveLength(3);
		expect(app().querySelector(".sl-segment__icon")?.className).toContain("fa-fw");
		store.emit(makeSnapshot({ license: "unknown" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("login");
		expect(app().querySelector<HTMLElement>(".sl-topbar")?.hidden).toBe(true);
		expect(mountedView()).toBe("login");
		expect(app().querySelector(".sl-view__title")?.textContent).toBe(COPY.login.title);
		store.emit(makeSnapshot());
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		expect(app().querySelector<HTMLElement>(".sl-topbar")?.hidden).toBe(false);
		expect(document.body.dataset.theme).toBe("dark");
		store.emit(
			makeSnapshot({ settings: { display: { ...makeSnapshot().settings.display, theme: "light" } } })
		);
		await dom.tick(0);
		expect(document.body.dataset.theme).toBe("light");
	});

	it("Alt+1/2/3 switch tabs; the segment reflects it; clicks on segments too", async () => {
		shell = bootShell(app(), { store });
		store.emit(makeSnapshot());
		await dom.tick(0);
		key(document, "keydown", { key: "2", code: "Digit2", altKey: true });
		await dom.tick(0);
		expect(shell.router.current).toBe("settings");
		expect(shell.ui.tab).toBe("settings");
		expect(
			app().querySelector('.sl-segment__item[data-value="settings"]')?.getAttribute("aria-selected")
		).toBe("true");
		key(document, "keydown", { key: "3", code: "Digit3", altKey: true });
		await dom.tick(0);
		expect(shell.router.current).toBe("engine");
		key(document, "keydown", { key: "1", code: "Digit1", altKey: true });
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		// Without Alt nothing happens.
		key(document, "keydown", { key: "2", code: "Digit2" });
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		const engineTab = app().querySelector<HTMLElement>('.sl-segment__item[data-value="engine"]');
		engineTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await dom.tick(0);
		expect(shell.router.current).toBe("engine");
	});

	it("hands-off mode: live game disables the switch, adds the root class, shows the banner", async () => {
		shell = bootShell(app(), { store });
		store.emit(makeSnapshot());
		await dom.tick(0);
		shell.setTab("settings");
		await dom.tick(0);
		expect(shell.router.current).toBe("settings");

		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(true);
		expect(shell.router.current).toBe("live");
		expect(app().classList.contains("sl-hands-off")).toBe(true);
		expect(app().querySelector(".sl-app__content")?.getAttribute("aria-disabled")).toBe("true");
		expect(app().querySelector(".sl-segment")?.getAttribute("aria-disabled")).toBe("true");
		const banner = app().querySelector(".sl-banner");
		expect(banner?.textContent?.trim()).toBe(COPY.banner.handsOff);
		expect(banner?.classList.contains("sl-banner--hands-off")).toBe(true);
		// The view switch is inert: Alt+2 and setTab are ignored.
		key(document, "keydown", { key: "2", code: "Digit2", altKey: true });
		shell.setTab("engine");
		await dom.tick(0);
		expect(shell.router.current).toBe("live");
		expect(shell.ui.tab).toBe("settings"); // unchanged

		// Game over: controls return, the banner leaves, the remembered tab comes back.
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(false);
		expect(app().classList.contains("sl-hands-off")).toBe(false);
		expect(app().querySelector(".sl-banner")).toBeNull();
		expect(shell.router.current).toBe("settings");
	});

	it("update interrupt: storage flag routes to update; Later returns and shows the info banner", async () => {
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.updateAvailable]: true });
		shell = bootShell(app(), { store, version: "2.1" });
		store.emit(makeSnapshot());
		await dom.tick(0);
		expect(shell.router.current).toBe("update");
		shell.dismissUpdate();
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		expect(app().querySelector(".sl-banner")?.textContent?.trim()).toContain(
			COPY.banner.update("2.1")
		);
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.updateAvailable]: false });
		await dom.tick(0);
		expect(app().querySelector(".sl-banner")).toBeNull();
	});

	it("hands-off outranks the update banner: waiting → update → Later → game starts", async () => {
		const updates: string[] = [];
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.updateAvailable]: true });
		shell = bootShell(app(), { store, version: "2.1", onUpdate: () => updates.push("update") });
		store.emit(makeSnapshot());
		await dom.tick(0);
		expect(shell.router.current).toBe("update");
		shell.dismissUpdate();
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		expect(currentBannerKind()).toBe("info");
		const updateButton = app().querySelector<HTMLElement>(".sl-app__banner .sl-button");
		expect(updateButton).not.toBeNull();

		// The game starts: the hands-off banner is the only banner; Update is not reachable.
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(true);
		expect(currentBannerKind()).toBe("hands-off");
		const banners = app().querySelectorAll(".sl-banner");
		expect(banners).toHaveLength(1);
		expect(banners[0]?.classList.contains("sl-banner--hands-off")).toBe(true);
		expect(banners[0]?.textContent?.trim()).toBe(COPY.banner.handsOff);
		expect(app().querySelector(".sl-app__banner .sl-button")).toBeNull();
		if (updateButton) click(updateButton); // a stale reference must not fire either
		expect(updates).toEqual([]);

		// A warn banner mid-game does not displace hands-off.
		const { showBanner } = await import("@panel/components/banner");
		const warn = showBanner("warn", COPY.banner.detached, [
			{ label: COPY.banner.reattach, onClick: () => {} },
		]);
		await dom.tick(0);
		expect(currentBannerKind()).toBe("hands-off");
		warn.dismiss();

		// Game over: the update banner comes back and its action works again.
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(currentBannerKind()).toBe("info");
		const again = app().querySelector<HTMLElement>(".sl-app__banner .sl-button");
		if (again) click(again);
		expect(updates).toEqual(["update"]);
	});

	it("hands-off blocks keyboard activation and exposes aria-disabled/tabindex on content controls", async () => {
		const changes: boolean[] = [];
		const refs: { toggle: ToggleHandle | null; button: HTMLButtonElement | null } = {
			toggle: null,
			button: null,
		};
		const liveView: View = {
			mount(ctx) {
				const section = document.createElement("section");
				section.dataset.view = "live";
				ctx.container.append(section);
				refs.toggle = createToggle(section, {
					label: COPY.toggle.highlight,
					checked: false,
					onChange: (v) => changes.push(v),
				});
				const b = document.createElement("button");
				b.type = "button";
				b.tabIndex = 0;
				section.append(b);
				refs.button = b;
				return () => section.remove();
			},
		};
		shell = bootShell(app(), { store, views: { live: liveView, waiting: liveView } });
		store.emit(makeSnapshot());
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		// Before hands-off the toggle works from the keyboard.
		refs.toggle?.el.focus();
		if (refs.toggle) key(refs.toggle.el, "keydown", { key: " ", code: "Space" });
		if (refs.toggle) key(refs.toggle.el, "keyup", { key: " ", code: "Space" });
		expect(changes).toEqual([true]);
		expect(refs.button?.getAttribute("aria-disabled")).toBeNull();

		// Live game: the view remounts under hands-off and every control is inert.
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("live");
		expect(refs.toggle?.el.getAttribute("aria-disabled")).toBe("true");
		expect(refs.toggle?.el.getAttribute("tabindex")).toBe("-1");
		expect(refs.button?.getAttribute("aria-disabled")).toBe("true");
		expect(refs.button?.getAttribute("tabindex")).toBe("-1");
		refs.toggle?.el.focus();
		if (refs.toggle) key(refs.toggle.el, "keydown", { key: " ", code: "Space" });
		if (refs.toggle) key(refs.toggle.el, "keyup", { key: " ", code: "Space" });
		if (refs.toggle) key(refs.toggle.el, "keydown", { key: "Enter", code: "Enter" });
		expect(changes).toEqual([true]);
		// Controls added while hands-off are locked too: synchronously on focus, and by the
		// MutationObserver (happy-dom delivers records on the window's own timer, hence the wait).
		const late = document.createElement("button");
		late.type = "button";
		app().querySelector(".sl-app__content > section")?.append(late);
		const early = document.createElement("button");
		early.type = "button";
		app().querySelector(".sl-app__content > section")?.append(early);
		early.dispatchEvent(new Event("focusin", { bubbles: true }));
		expect(early.getAttribute("aria-disabled")).toBe("true");
		expect(early.getAttribute("tabindex")).toBe("-1");
		await new Promise<void>((resolve) => dom.panel.window.setTimeout(resolve, 0));
		await dom.tick(0);
		expect(late.getAttribute("aria-disabled")).toBe("true");
		expect(late.getAttribute("tabindex")).toBe("-1");

		// Game over: the locked controls get their previous attributes back (tabindex 0 kept,
		// none re-added where there was none) — checked on the pre-game references, since the
		// router remounts the view (live → waiting) and the new controls start untouched.
		const lockedToggle = refs.toggle;
		const lockedButton = refs.button;
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(false);
		expect(shell.router.current).toBe("waiting");
		expect(lockedButton?.getAttribute("aria-disabled")).toBeNull();
		expect(lockedButton?.getAttribute("tabindex")).toBe("0");
		expect(lockedToggle?.el.getAttribute("aria-disabled")).toBeNull();
		expect(lockedToggle?.el.getAttribute("tabindex")).toBeNull();
		expect(late.getAttribute("aria-disabled")).toBeNull();
		expect(late.getAttribute("tabindex")).toBeNull();
		expect(refs.button?.getAttribute("aria-disabled")).toBeNull();
		expect(refs.button?.getAttribute("tabindex")).toBe("0");
		expect(refs.toggle?.el.getAttribute("aria-disabled")).toBeNull();
		// The freshly mounted toggle works from the keyboard again.
		if (refs.toggle) key(refs.toggle.el, "keydown", { key: " ", code: "Space" });
		if (refs.toggle) key(refs.toggle.el, "keyup", { key: " ", code: "Space" });
		expect(changes).toEqual([true, true]);
	});

	it("hands-off closes an open popover so nothing inside it can act mid-game", async () => {
		const confirmed: string[] = [];
		const view: View = {
			mount(ctx) {
				const section = document.createElement("section");
				section.dataset.view = "waiting";
				const anchor = document.createElement("button");
				anchor.type = "button";
				section.append(anchor);
				const body = document.createElement("div");
				const ok = document.createElement("button");
				ok.type = "button";
				ok.addEventListener("click", () => confirmed.push("ok"));
				body.append(ok);
				anchor.addEventListener("click", () => void openPopover(anchor, body, { title: "t" }));
				ctx.container.append(section);
				return () => section.remove();
			},
		};
		shell = bootShell(app(), { store, views: { waiting: view } });
		store.emit(makeSnapshot());
		await dom.tick(0);
		const anchor = app().querySelector<HTMLElement>(".sl-app__content button");
		if (anchor) click(anchor);
		expect(app().querySelector(".sl-popover")).not.toBeNull();
		const ok = app().querySelector<HTMLElement>(".sl-popover .sl-popover__body button");
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(true);
		expect(app().querySelector(".sl-popover")).toBeNull();
		expect(ok?.isConnected).toBe(false);
	});

	it("dispose tears everything down", async () => {
		shell = bootShell(app(), { store });
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		shell.dispose();
		shell = null;
		expect(app().children).toHaveLength(0);
		expect(app().classList.contains("sl-app")).toBe(false);
		key(document, "keydown", { key: "2", code: "Digit2", altKey: true });
		await dom.tick(0);
		expect(app().children).toHaveLength(0);
	});
});
