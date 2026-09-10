// test/panel/views/unsupported.test.ts — Appendix F §4.2: not on a supported site vs a non-game
// page of a supported site; the site buttons are shell `open-url` actions.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { URLS } from "@core/constants";
import { PLAY_URL } from "@panel/actions";
import { COPY } from "@panel/copy";
import { unsupportedView } from "@panel/views/unsupported";
import { bootPanelDom, mount, type PanelDom } from "../dom";
import { makeSnapshot } from "../fixtures";
import { type FakeStore, fakeStore, makeContext } from "./fake-store";

let dom: PanelDom;
let cleanup: (() => void) | null = null;
let store: FakeStore;
let container: HTMLElement;

beforeEach(async () => {
	dom = await bootPanelDom();
	container = mount(document.createElement("main"));
});
afterEach(async () => {
	cleanup?.();
	cleanup = null;
	await dom.teardown();
});

const text = (selector: string): string =>
	container.querySelector(selector)?.textContent?.trim() ?? "";
const actions = (): HTMLButtonElement[] => [
	...container.querySelectorAll<HTMLButtonElement>(".sl-empty__actions .sl-button"),
];

describe("unsupportedView", () => {
	it("off-site: board icon, copy, the chess.com ghost button, note; nothing focused", async () => {
		store = fakeStore(makeSnapshot({ site: null }));
		cleanup = await unsupportedView.mount(makeContext(container, store));
		expect(container.querySelector("[data-view=unsupported]")).not.toBeNull();
		expect(container.querySelector(".sl-empty__icon")?.getAttribute("data-icon")).toBe("game.board");
		expect(text(".sl-empty__title")).toBe(COPY.unsupported.title);
		expect(text(".sl-empty__body")).toBe(COPY.unsupported.body);
		expect(text(".sl-empty__note")).toBe(COPY.unsupported.note);
		expect(actions()).toHaveLength(1);
		const [chesscom] = actions();
		expect(chesscom?.textContent?.trim()).toBe(COPY.unsupportedView.chesscom);
		expect(chesscom?.dataset.action).toBe("open-url");
		expect(chesscom?.dataset.url).toBe("chesscom");
		expect(chesscom?.classList.contains("sl-button--ghost")).toBe(true);
		expect(chesscom?.classList.contains("sl-button--md")).toBe(true);
		expect(chesscom?.querySelector(".sl-button__icon")?.getAttribute("data-icon")).toBe(
			"action.external"
		);
		expect(URLS.chesscom).toMatch(/^https:\/\/www\.chess\.com/);
		expect(document.activeElement).toBe(document.body);
	});

	it("non-game chess.com page: the variant copy and the Play deep link", async () => {
		const snapshot = makeSnapshot({ site: "chesscom" });
		snapshot.pageKind = "puzzles";
		store = fakeStore(snapshot);
		cleanup = await unsupportedView.mount(makeContext(container, store));
		expect(text(".sl-empty__title")).toBe(COPY.nonGame.title);
		expect(text(".sl-empty__body")).toBe(COPY.nonGame.body);
		expect(actions()).toHaveLength(1);
		expect(actions()[0]?.textContent?.trim()).toBe(COPY.unsupportedView.play);
		expect(actions()[0]?.dataset.url).toBe(PLAY_URL);
		expect(PLAY_URL).toBe("chesscomPlay");
		expect(URLS.chesscomPlay).toBe("https://www.chess.com/play/online");

		// Follows snapshots: leaving the site restores the off-site variant.
		store.emit(makeSnapshot({ site: null }));
		expect(text(".sl-empty__title")).toBe(COPY.unsupported.title);
		expect(actions()).toHaveLength(1);
		cleanup?.();
		cleanup = null;
		expect(container.children).toHaveLength(0);
	});
});
