// test/panel/views/update.test.ts — Appendix F §4.8: the interrupt card (mark, title, notes,
// Restart and update / Later, note) and, through the shell, Later → info banner, never
// re-interrupts, deferred while a game is live.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IMAGES, LOCAL_KEYS, type PanelSnapshot } from "@core/constants";
import { currentBannerKind } from "@panel/components/banner";
import { COPY } from "@panel/copy";
import { bootShell, type PanelShell } from "@panel/shell";
import { createUpdateView, updateView } from "@panel/views/update";
import { bootPanelDom, click, mount, type PanelDom } from "../dom";
import { makeSnapshot } from "../fixtures";
import { type FakeStore, fakeStore, makeContext } from "./fake-store";

let dom: PanelDom;
let cleanup: (() => void) | null = null;
let shell: PanelShell | null = null;
let store: FakeStore;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	cleanup?.();
	cleanup = null;
	shell?.dispose();
	shell = null;
	await dom.teardown();
});

const app = (): HTMLElement => {
	const el = document.getElementById("app");
	if (!el) throw new Error("no #app");
	return el;
};

describe("updateView", () => {
	it("renders the §4.8 card from copy with injectable version/notes/onUpdate", async () => {
		const container = mount(document.createElement("main"));
		store = fakeStore(makeSnapshot());
		const updates: string[] = [];
		const view = createUpdateView({
			version: "2.1",
			notes: "Auto-play now verifies each move on the live board.",
			onUpdate: () => updates.push("update"),
		});
		cleanup = await view.mount(makeContext(container, store));
		expect(container.querySelector("[data-view=update]")).not.toBeNull();
		const mark = container.querySelector<HTMLImageElement>(".sl-update__mark");
		expect(mark?.getAttribute("src")).toContain(IMAGES.mark);
		expect(container.querySelector(".sl-empty__title")?.textContent).toBe(COPY.update.title("2.1"));
		expect(container.querySelector(".sl-empty__body")?.textContent).toBe(
			"Auto-play now verifies each move on the live board."
		);
		const [primary, later] = [
			...container.querySelectorAll<HTMLButtonElement>(".sl-empty__actions .sl-button"),
		];
		expect(primary?.textContent?.trim()).toBe(COPY.update.primary);
		expect(primary?.classList.contains("sl-button--primary")).toBe(true);
		expect(later?.textContent?.trim()).toBe(COPY.update.later);
		expect(later?.classList.contains("sl-button--ghost")).toBe(true);
		expect(later?.dataset.action).toBe("dismiss-update");
		expect(container.querySelector(".sl-empty__note")?.textContent).toBe(COPY.update.note);
		if (primary) click(primary);
		expect(updates).toEqual(["update"]);
		expect(document.activeElement).toBe(document.body);
		cleanup?.();
		cleanup = null;
		expect(container.children).toHaveLength(0);
	});

	it("defaults: the build version and no notes", async () => {
		const container = mount(document.createElement("main"));
		store = fakeStore(makeSnapshot());
		cleanup = await updateView.mount(makeContext(container, store));
		expect(container.querySelector(".sl-empty__title")?.textContent).toBe(
			COPY.update.title(__SL_VERSION__)
		);
		expect(container.querySelector<HTMLElement>(".sl-empty__body")?.hidden).toBe(true);
	});

	it("through the shell: Later leaves the info banner, never re-interrupts, and the interrupt waits for a live game to end", async () => {
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.updateAvailable]: true });
		store = fakeStore();
		// The boot code (Task 27/31) injects the versioned view; the shell only knows the banner's.
		shell = bootShell(app(), {
			store,
			version: "2.1",
			views: { update: createUpdateView({ version: "2.1" }) },
		});
		// A live game when the flag is discovered: the interrupt is deferred, only the banner shows.
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("live");
		expect(app().querySelector(".sl-update")).toBeNull();
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("update");
		expect(app().querySelector(".sl-update .sl-empty__title")?.textContent).toBe(
			COPY.update.title("2.1")
		);

		const later = app().querySelector<HTMLElement>(".sl-update [data-action=dismiss-update]");
		if (!later) throw new Error("no Later");
		click(later);
		await dom.tick(0);
		expect(shell.router.current).toBe("waiting");
		expect(currentBannerKind()).toBe("info");
		expect(app().querySelector(".sl-banner__text")?.textContent).toBe(COPY.banner.update("2.1"));

		// Later snapshots never bring the interrupt back.
		const snapshots: PanelSnapshot[] = [
			makeSnapshot({ state: "idle" }),
			makeSnapshot({ state: "live:my-turn:analysing" }),
			makeSnapshot({ state: "game-over" }),
			makeSnapshot(),
		];
		for (const s of snapshots) {
			store.emit(s);
			await dom.tick(0);
			expect(shell.router.current).not.toBe("update");
		}
		expect(currentBannerKind()).toBe("info");
	});
});
