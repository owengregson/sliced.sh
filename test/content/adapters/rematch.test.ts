// test/content/adapters/rematch.test.ts — 2026-09-13: the opponent's title is read from the
// opponent's player card only, and `rematchTarget` / `incomingRematch` discover the post-game
// rematch controls the owner captured without activating any of them, revalidating by id and
// point exactly the way `newGameTarget` does.
import { afterEach, describe, expect, it } from "bun:test";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { TITLES } from "@core/constants/rematch";
import { installWindowGlobals } from "@test/sim/dom/tab-dom";
import { type FixtureName, loadFixture, pageDocument, pageWindow } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const clean of cleanups.splice(0).reverse()) clean();
});
const REMATCH_RECT = { x: 500, y: 620, width: 140, height: 44 };
const NEW_GAME_RECT = { x: 340, y: 620, width: 140, height: 44 };
const ACCEPT_RECT = { x: 500, y: 620, width: 120, height: 40 };
const DECLINE_RECT = { x: 360, y: 620, width: 120, height: 40 };

/** The owner's captures, verbatim: the two buttons, and the incoming panel that replaces them. */
const OUTGOING =
	'<div class="game-over-buttons-component"><div class="game-over-buttons-buttons">' +
	'<button id="new" class="cc-button-component cc-button-primary cc-button-large" type="button" aria-label="New Game"><span class="">New 3 min</span></button> ' +
	'<button id="offer" class="cc-button-component cc-button-secondary cc-button-large cc-bg-secondary" type="button" aria-label="Rematch"><!----> <!----> <span class="">Rematch</span> <!----></button>' +
	"</div></div>";
const INCOMING =
	'<div class="game-over-buttons-component"><div class="game-over-buttons-incoming-rematch"><span class="game-over-buttons-label">Good game! Rematch?</span> ' +
	'<div class="game-over-secondary-actions-row-component game-over-buttons-buttons">' +
	'<button id="decline" class="cc-button-component cc-button-secondary cc-button-medium cc-bg-secondary" type="button" aria-label="Decline Rematch">…<span class="">Decline</span></button> ' +
	'<button id="accept" class="cc-button-component cc-button-secondary cc-button-medium cc-bg-secondary" type="button" aria-label="Accept Rematch">…<span class="">Accept</span></button>' +
	"</div></div></div>";

function boot(name: FixtureName = "chesscom-gameover", markup = OUTGOING) {
	const dom = loadFixture(name);
	cleanups.push(installWindowGlobals(dom.window));
	const adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
	cleanups.push(() => adapter.destroy());
	for (const button of dom.document.querySelectorAll("button")) button.remove();
	dom.document.body.insertAdjacentHTML("beforeend", markup);
	const clicks: string[] = [];
	for (const button of dom.document.querySelectorAll("button"))
		button.addEventListener("click", () => clicks.push(button.id));
	return { dom, adapter, clicks };
}

describe("the opponent's title", () => {
	it("is read from the opponent's card, normalised, and absent when the card has none", () => {
		const { dom, adapter } = boot("chesscom-live");
		expect(adapter.getOpponent()?.title).toBeUndefined();
		const top = dom.query("#board-layout-player-top .cc-user-block-component");
		top.insertAdjacentHTML(
			"afterbegin",
			'<div class="cc-user-title-component cc-text-x-small-bold"> fm </div>'
		);
		expect(adapter.getOpponent()).toEqual({
			isBot: false,
			name: "MagnusFan99",
			ratingEstimate: 1850,
			title: "FM",
		});
	});

	it("our own title never counts as the opponent's", () => {
		const { dom, adapter } = boot("chesscom-live");
		dom
			.query("#board-layout-player-bottom .cc-user-block-component")
			.insertAdjacentHTML(
				"afterbegin",
				'<div class="cc-user-title-component cc-text-x-small-bold">GM</div>'
			);
		expect(adapter.getOpponent()?.title).toBeUndefined();
	});

	it.each([...TITLES])("recognises %s", (title) => {
		const { dom, adapter } = boot("chesscom-live");
		dom
			.query("#board-layout-player-top .cc-user-block-component")
			.insertAdjacentHTML(
				"afterbegin",
				`<div class="cc-user-title-component cc-text-x-small-bold">${title}</div>`
			);
		expect(adapter.getOpponent()?.title).toBe(title);
	});

	it("text that is not a title is not one", () => {
		const { dom, adapter } = boot("chesscom-live");
		dom
			.query("#board-layout-player-top .cc-user-block-component")
			.insertAdjacentHTML(
				"afterbegin",
				'<div class="cc-user-title-component cc-text-x-small-bold">Top player 2024</div>'
			);
		expect(adapter.getOpponent()?.title).toBeUndefined();
	});
});

describe("rematch control discovery", () => {
	it("finds the outgoing Rematch button and never the new-game one, without clicking either", () => {
		const { dom, adapter, clicks } = boot();
		dom.layout("#offer", REMATCH_RECT);
		dom.layout("#new", NEW_GAME_RECT);
		const result = adapter.rematchTarget("rematch");
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.target.rect).toEqual({
			left: REMATCH_RECT.x,
			top: REMATCH_RECT.y,
			width: REMATCH_RECT.width,
			height: REMATCH_RECT.height,
		});
		expect(adapter.incomingRematch()).toBe(false);
		expect(adapter.rematchTarget("accept").status).toBe("not-ready");
		expect(adapter.rematchTarget("decline").status).toBe("not-ready");
		expect(adapter.rematchTarget("cancel").status).toBe("not-ready");
		expect(adapter.newGameTarget("new").status).toBe("ready");
		expect(clicks).toEqual([]);
	});

	it("revalidates by id and point, like the new-game control", () => {
		const { dom, adapter } = boot();
		dom.layout("#offer", REMATCH_RECT);
		dom.layout("#new", NEW_GAME_RECT);
		const first = adapter.rematchTarget("rematch");
		if (first.status !== "ready") throw new Error("expected a target");
		const inside = { x: REMATCH_RECT.x + 10, y: REMATCH_RECT.y + 10 };
		const again = adapter.rematchTarget("rematch", first.target.targetId, inside);
		expect(again.status).toBe("ready");
		if (again.status === "ready") expect(again.target.targetId).toBe(first.target.targetId);
		expect(adapter.rematchTarget("rematch", "someone-else", inside).status).toBe("not-ready");
		// The point lands on the new-game button: not the element the rect was read from.
		expect(
			adapter.rematchTarget("rematch", first.target.targetId, {
				x: NEW_GAME_RECT.x + 5,
				y: NEW_GAME_RECT.y + 5,
			}).status
		).toBe("not-ready");
	});

	it("the incoming panel: Accept and Decline are found, the outgoing offer is not, and `incomingRematch` is true", () => {
		const { dom, adapter, clicks } = boot("chesscom-gameover", INCOMING);
		dom.layout("#accept", ACCEPT_RECT);
		dom.layout("#decline", DECLINE_RECT);
		expect(adapter.incomingRematch()).toBe(true);
		const accept = adapter.rematchTarget("accept");
		expect(accept.status).toBe("ready");
		if (accept.status === "ready") expect(accept.target.rect.left).toBe(ACCEPT_RECT.x);
		const decline = adapter.rematchTarget("decline");
		expect(decline.status).toBe("ready");
		if (decline.status === "ready") expect(decline.target.rect.left).toBe(DECLINE_RECT.x);
		// "Accept Rematch" contains the word, but it is not our offer.
		expect(adapter.rematchTarget("rematch").status).toBe("not-ready");
		expect(clicks).toEqual([]);
	});

	it("a hidden or disabled panel is not an incoming offer", () => {
		const { dom, adapter } = boot("chesscom-gameover", INCOMING);
		dom.layout("#accept", ACCEPT_RECT);
		dom.layout("#decline", DECLINE_RECT);
		const panel = dom.query(".game-over-buttons-incoming-rematch");
		panel.setAttribute("hidden", "");
		expect(adapter.incomingRematch()).toBe(false);
		expect(adapter.rematchTarget("accept").status).toBe("not-ready");
		panel.removeAttribute("hidden");
		dom.query("#accept").setAttribute("disabled", "");
		expect(adapter.incomingRematch()).toBe(false);
	});

	it("a cancel inside the game-over buttons is found by label; a matchmaking cancel is not", () => {
		const { dom, adapter } = boot(
			"chesscom-gameover",
			'<div class="game-over-buttons-component"><div class="game-over-buttons-buttons">' +
				'<button id="search" aria-label="Cancel Search">Cancel</button>' +
				'<button id="withdraw" aria-label="Cancel Rematch">Cancel</button></div></div>'
		);
		dom.layout("#search", NEW_GAME_RECT);
		dom.layout("#withdraw", REMATCH_RECT);
		const cancel = adapter.rematchTarget("cancel");
		expect(cancel.status).toBe("ready");
		if (cancel.status === "ready") expect(cancel.target.rect.left).toBe(REMATCH_RECT.x);
		dom.query("#withdraw").remove();
		expect(adapter.rematchTarget("cancel").status).toBe("not-ready");
	});

	it("a running game answers `in-game`; a page that is not a live page answers `not-ready`", () => {
		const live = boot("chesscom-live");
		live.dom.layout("#offer", REMATCH_RECT);
		expect(live.adapter.rematchTarget("rematch").status).toBe("in-game");
		const computer = boot("chesscom-computer");
		computer.dom.layout("#offer", REMATCH_RECT);
		expect(computer.adapter.rematchTarget("rematch").status).toBe("not-ready");
	});
});
