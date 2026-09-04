// test/panel/shell.test.ts — the shell as a projection of snapshots: top bar / view switch,
// `Alt+1/2/3`, hands-off mode (§13.4) with its banner and disabled controls, update interrupt.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_KEYS, type PanelSnapshot } from "@core/constants";
import { COPY } from "@panel/copy";
import { bootShell, type PanelShell } from "@panel/shell";
import type { PanelStore } from "@panel/store";
import { bootPanelDom, key, type PanelDom } from "./dom";
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
		expect(banner?.classList.contains("sl-banner--info")).toBe(true);
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
