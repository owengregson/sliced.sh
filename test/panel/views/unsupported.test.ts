// test/panel/views/unsupported.test.ts — Appendix F §4.2: not on a supported site vs a non-game
// page of a supported site; the site buttons are shell `open-url` actions.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { URLS } from "@core/constants";
import { COPY } from "@panel/copy";
import { PLAY_URL } from "@panel/views/play-url";
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
	it("no supported site: board icon, copy, two ghost site buttons, note; nothing focused", async () => {
		store = fakeStore(makeSnapshot({ site: null }));
		cleanup = await unsupportedView.mount(makeContext(container, store));
		expect(container.querySelector("[data-view=unsupported]")).not.toBeNull();
		expect(container.querySelector(".sl-empty__icon")?.getAttribute("data-icon")).toBe("game.board");
		expect(text(".sl-empty__title")).toBe(COPY.unsupported.title);
		expect(text(".sl-empty__body")).toBe(COPY.unsupported.body);
		expect(text(".sl-empty__note")).toBe(COPY.unsupported.note);
		const [chesscom, lichess] = actions();
		expect(chesscom?.textContent?.trim()).toBe(COPY.unsupportedView.chesscom);
		expect(chesscom?.dataset.action).toBe("open-url");
		expect(chesscom?.dataset.url).toBe("chesscom");
		expect(chesscom?.classList.contains("sl-button--ghost")).toBe(true);
		expect(chesscom?.classList.contains("sl-button--md")).toBe(true);
		expect(chesscom?.querySelector(".sl-button__icon")?.getAttribute("data-icon")).toBe(
			"action.external"
		);
		expect(lichess?.textContent?.trim()).toBe(COPY.unsupportedView.lichess);
		expect(lichess?.dataset.url).toBe("lichess");
		expect(URLS.chesscom).toMatch(/^https:\/\/www\.chess\.com/);
		expect(URLS.lichess).toMatch(/^https:\/\/lichess\.org/);
		expect(document.activeElement).toBe(document.body);
	});

	it("non-game page of a supported site: the variant copy and one Play deep link", async () => {
		const snapshot = makeSnapshot({ site: "chesscom" });
		snapshot.pageKind = "puzzles";
		store = fakeStore(snapshot);
		cleanup = await unsupportedView.mount(makeContext(container, store));
		expect(text(".sl-empty__title")).toBe(COPY.nonGame.title);
		expect(text(".sl-empty__body")).toBe(COPY.nonGame.body);
		expect(actions()).toHaveLength(1);
		expect(actions()[0]?.textContent?.trim()).toBe(COPY.unsupportedView.play);
		expect(actions()[0]?.dataset.url).toBe(PLAY_URL.chesscom);
		expect(PLAY_URL.chesscom).toBe("chesscomPlay");
		expect(URLS.chesscomPlay).toBe("https://www.chess.com/play/online");

		// Follows snapshots: lichess deep-links to the lobby; leaving the site restores the default.
		const lichess = makeSnapshot({ site: "lichess" });
		lichess.pageKind = "analysis";
		store.emit(lichess);
		expect(actions()[0]?.dataset.url).toBe("lichessLobby");
		expect(URLS.lichessLobby).toMatch(/^https:\/\/lichess\.org/);
		store.emit(makeSnapshot({ site: null }));
		expect(text(".sl-empty__title")).toBe(COPY.unsupported.title);
		expect(actions()).toHaveLength(2);
		cleanup?.();
		cleanup = null;
		expect(container.children).toHaveLength(0);
	});
});
