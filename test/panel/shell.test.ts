// test/panel/shell.test.ts — the shell as a projection of snapshots: top bar / view switch,
// navigation, live interaction, and the deferred update interrupt.
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
		expect(app().querySelector(".sl-topbar__wordmark")?.textContent).toBe(COPY.brand.product);
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

	it("keeps the selected panel and navigation available when a game starts", async () => {
		shell = bootShell(app(), { store });
		store.emit(makeSnapshot());
		await dom.tick(0);
		shell.setTab("settings");
		await dom.tick(0);
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(false);
		expect(shell.router.current).toBe("settings");
		expect(app().classList.contains("sl-hands-off")).toBe(false);
		expect(app().querySelector(".sl-app__content")?.getAttribute("aria-disabled")).toBeNull();
		expect(app().querySelector(".sl-segment")?.getAttribute("aria-disabled")).toBeNull();
		expect(app().querySelector(".sl-banner--hands-off")).toBeNull();
		shell.setTab("engine");
		await dom.tick(0);
		expect(shell.router.current).toBe("engine");
		expect(shell.ui.tab).toBe("engine");
		expect(
			app().querySelector('.sl-topbar__switch [aria-selected="true"]')?.getAttribute("data-value")
		).toBe("engine");
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("engine");
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

	it("defers the reload prompt during play while allowing ordinary warning banners", async () => {
		const updates: string[] = [];
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.updateAvailable]: true });
		shell = bootShell(app(), { store, version: "2.1", onUpdate: () => updates.push("update") });
		store.emit(makeSnapshot());
		await dom.tick(0);
		expect(shell.router.current).toBe("update");
		shell.dismissUpdate();
		await dom.tick(0);
		expect(currentBannerKind()).toBe("info");
		const updateButton = app().querySelector<HTMLElement>(".sl-app__banner .sl-button");
		expect(updateButton).not.toBeNull();
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(false);
		expect(app().querySelector(".sl-banner")).toBeNull();
		if (updateButton) click(updateButton);
		expect(updates).toEqual([]);
		const { showBanner } = await import("@panel/components/banner");
		const warn = showBanner("warn", COPY.banner.detached, [
			{ label: COPY.banner.reattach, onClick: () => {} },
		]);
		await dom.tick(0);
		expect(currentBannerKind()).toBe("warn");
		warn.dismiss();
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(currentBannerKind()).toBe("info");
		const again = app().querySelector<HTMLElement>(".sl-app__banner .sl-button");
		if (again) click(again);
		expect(updates).toEqual(["update"]);
	});

	it("retains keyboard activation and native focus attributes on live and dynamically added controls", async () => {
		const changes: boolean[] = [];
		const refs: { toggle: ToggleHandle | null; button: HTMLButtonElement | null } = {
			toggle: null,
			button: null,
		};
		const liveView: View = {
			mount(ctx) {
				const section = document.createElement("section");
				ctx.container.append(section);
				refs.toggle = createToggle(section, {
					label: COPY.toggle.highlight,
					checked: false,
					onChange: (v) => changes.push(v),
				});
				const button = document.createElement("button");
				button.type = "button";
				button.tabIndex = 0;
				section.append(button);
				refs.button = button;
				return () => section.remove();
			},
		};
		shell = bootShell(app(), { store, views: { live: liveView, waiting: liveView } });
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("live");
		expect(refs.toggle?.el.getAttribute("aria-disabled")).toBeNull();
		expect(refs.button?.getAttribute("aria-disabled")).toBeNull();
		expect(refs.button?.getAttribute("tabindex")).toBe("0");
		refs.toggle?.el.focus();
		if (refs.toggle) key(refs.toggle.el, "keydown", { key: "Enter", code: "Enter" });
		if (refs.toggle) key(refs.toggle.el, "keyup", { key: "Enter", code: "Enter" });
		expect(changes).toEqual([true]);
		const late = document.createElement("button");
		late.type = "button";
		app().querySelector(".sl-app__content > section")?.append(late);
		late.dispatchEvent(new Event("focusin", { bubbles: true }));
		await new Promise<void>((resolve) => dom.panel.window.setTimeout(resolve, 0));
		await dom.tick(0);
		expect(late.getAttribute("aria-disabled")).toBeNull();
		expect(late.getAttribute("tabindex")).toBeNull();
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		if (refs.toggle) key(refs.toggle.el, "keydown", { key: "Enter", code: "Enter" });
		if (refs.toggle) key(refs.toggle.el, "keyup", { key: "Enter", code: "Enter" });
		expect(changes).toEqual([true, true]);
	});

	it("keeps a settings popover interactive when a game starts", async () => {
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
		shell = bootShell(app(), { store, views: { settings: view } });
		shell.setTab("settings");
		store.emit(makeSnapshot());
		await dom.tick(0);
		const anchor = app().querySelector<HTMLElement>(".sl-app__content button");
		if (anchor) click(anchor);
		expect(app().querySelector(".sl-popover")).not.toBeNull();
		const ok = app().querySelector<HTMLElement>(".sl-popover .sl-popover__body button");
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(false);
		expect(shell.router.current).toBe("settings");
		expect(app().querySelector(".sl-popover")).not.toBeNull();
		expect(ok?.isConnected).toBe(true);
		if (ok) click(ok);
		expect(confirmed).toEqual(["ok"]);
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
