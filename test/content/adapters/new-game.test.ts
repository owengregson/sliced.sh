import { afterEach, describe, expect, it } from "bun:test";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { installWindowGlobals } from "@test/sim/dom/tab-dom";
import { type FixtureName, loadFixture, pageDocument, pageWindow } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const clean of cleanups.splice(0).reverse()) clean();
});
const RECT = { x: 200, y: 200, width: 150, height: 40 };
function boot(name: FixtureName = "chesscom-gameover") {
	const dom = loadFixture(name);
	cleanups.push(installWindowGlobals(dom.window));
	const adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
	cleanups.push(() => adapter.destroy());
	return { dom, adapter };
}

describe("restart control discovery", () => {
	it("requires positive New Game labels in generic containers and never cancels an existing search", () => {
		const { dom, adapter } = boot();
		for (const button of dom.document.querySelectorAll("button")) button.remove();
		dom.query(".new-game-buttons-component").innerHTML =
			'<button id="rematch">Rematch</button><button id="next">New 3 min</button>';
		dom.layout("button", RECT);
		const clicks: string[] = [];
		for (const button of dom.document.querySelectorAll("button"))
			button.addEventListener("click", () => clicks.push(button.id));
		expect(adapter.tryStartNewGame("new")).toBe("started");
		expect(clicks).toEqual(["next"]);
		dom.query("#next").setAttribute("aria-label", "New Game");
		dom.query("#next").textContent = "Cancel";
		for (let i = 0; i < 3; i++) expect(adapter.tryStartNewGame("new")).toBe("searching");
		expect(clicks).toEqual(["next"]);
		dom.query("#next").remove();
		expect(adapter.tryStartNewGame("new")).toBe("not-ready");
		expect(clicks).toEqual(["next"]);
	});

	it("skips disabled and hidden modal copies and retries when the sidebar action becomes ready", () => {
		const { dom, adapter } = boot();
		dom.layout("button", RECT);
		for (const button of dom.document.querySelectorAll("button")) button.setAttribute("disabled", "");
		const next = dom.query('[data-cy="sidebar-game-over-new-game-button"]');
		next.removeAttribute("disabled");
		const holder = next.parentElement!;
		holder.setAttribute("hidden", "");
		let clicked = 0;
		next.addEventListener("click", () => clicked++);
		expect(adapter.tryStartNewGame("new")).toBe("not-ready");
		holder.removeAttribute("hidden");
		next.setAttribute("aria-busy", "true");
		expect(adapter.tryStartNewGame("new")).toBe("not-ready");
		next.removeAttribute("aria-busy");
		holder.setAttribute("style", "opacity:0");
		expect(adapter.tryStartNewGame("new")).toBe("not-ready");
		holder.removeAttribute("style");
		dom.layoutElement(next, { ...RECT, y: 900 });
		expect(adapter.tryStartNewGame("new")).toBe("not-ready");
		dom.layoutElement(next, RECT);
		expect(adapter.tryStartNewGame("new")).toBe("started");
		expect(clicked).toBe(1);
	});

	it("does not activate stale-game or in-progress controls and does not equate a paused board with a new game", () => {
		const over = boot();
		over.dom.layout("button", RECT);
		let before = 0;
		expect(over.adapter.tryStartNewGame("new", () => before++, "old-game")).toBe("in-game");
		expect(before).toBe(0);
		const live = boot("chesscom-live");
		live.dom.document.body.insertAdjacentHTML(
			"beforeend",
			'<button aria-label="New Game">New Game</button>'
		);
		live.dom.layout("button", RECT);
		expect(live.adapter.tryStartNewGame("new", () => before++)).toBe("in-game");
		expect(before).toBe(0);
		live.dom.query('button[aria-label="New Game"]').remove();
		for (const clock of live.dom.document.querySelectorAll(".clock-component"))
			clock.classList.remove("clock-player-turn", "clock-playerTurn", "running");
		expect(live.adapter.tryStartNewGame("new")).toBe("not-ready");
	});

	it("recognizes Play Again only for computer games", () => {
		for (const name of ["chesscom-computer", "chesscom-gameover"] as const) {
			const { dom, adapter } = boot(name);
			for (const button of dom.document.querySelectorAll("button")) button.remove();
			dom.document.body.insertAdjacentHTML(
				"beforeend",
				'<div class="game-over-modal-shell-buttons"><button data-cy="game-over-modal-play-again-button">Play Again</button></div>'
			);
			dom.layout("button", RECT);
			expect(adapter.tryStartNewGame("new")).toBe(
				name === "chesscom-computer" ? "started" : "not-ready"
			);
		}
	});

	it("waits for a delayed control and ignores a hidden queue indicator", () => {
		const { dom, adapter } = boot();
		for (const button of dom.document.querySelectorAll("button")) button.remove();
		expect(adapter.tryStartNewGame("new")).toBe("not-ready");
		dom.query(".new-game-buttons-component").innerHTML =
			'<button hidden aria-label="Cancel Search">Cancel</button><button aria-label="New Game">New Game</button>';
		dom.layout("button", RECT);
		expect(adapter.tryStartNewGame("new")).toBe("started");
		dom.query('[aria-label="Cancel Search"]').removeAttribute("hidden");
		expect(adapter.tryStartNewGame("new")).toBe("searching");
	});
});
