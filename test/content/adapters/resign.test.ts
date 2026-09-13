// test/content/adapters/resign.test.ts — 2026-09-12: `resignTarget` discovers the resign control
// and its confirmation without activating either, accepts only positively labelled, usable
// controls, and revalidates by id and point exactly the way `newGameTarget` does.
import { afterEach, describe, expect, it } from "bun:test";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { installWindowGlobals } from "@test/sim/dom/tab-dom";
import { type FixtureName, loadFixture, pageDocument, pageWindow } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const clean of cleanups.splice(0).reverse()) clean();
});
const RESIGN_RECT = { x: 500, y: 620, width: 120, height: 40 };
const CONFIRM_RECT = { x: 660, y: 620, width: 100, height: 40 };

function boot(name: FixtureName = "chesscom-live") {
	const dom = loadFixture(name);
	cleanups.push(installWindowGlobals(dom.window));
	const adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
	cleanups.push(() => adapter.destroy());
	dom.document.body.insertAdjacentHTML(
		"beforeend",
		'<div class="game-controls-component"><button id="draw" aria-label="Offer draw">Draw</button>' +
			'<button id="resign" aria-label="Resign">Resign</button></div>' +
			'<div id="prompt" class="board-modal-container" hidden>' +
			'<button id="no">No</button><button id="confirm" class="confirm-button">Resign</button></div>'
	);
	dom.layout("#draw", { ...RESIGN_RECT, x: 360 });
	dom.layout("#resign", RESIGN_RECT);
	dom.layout("#no", { ...CONFIRM_RECT, x: 800 });
	dom.layout("#confirm", CONFIRM_RECT);
	const clicks: string[] = [];
	for (const button of dom.document.querySelectorAll("button"))
		button.addEventListener("click", () => clicks.push(button.id));
	return { dom, adapter, clicks };
}

describe("resign control discovery", () => {
	it("finds the positively labelled resign control among its siblings and never clicks it", () => {
		const { adapter, clicks } = boot();
		const result = adapter.resignTarget("resign");
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.target.rect).toEqual({
			left: RESIGN_RECT.x,
			top: RESIGN_RECT.y,
			width: RESIGN_RECT.width,
			height: RESIGN_RECT.height,
		});
		expect(result.target.targetId).not.toBe("");
		expect(clicks).toEqual([]);
	});

	it("the confirmation is not a target until it is shown, then only the affirmative button is", () => {
		const { dom, adapter, clicks } = boot();
		// The real flow reads the resign control first; its "Resign" label must never be taken for
		// its own confirmation even though the confirm regex accepts that word.
		expect(adapter.resignTarget("resign").status).toBe("ready");
		expect(adapter.resignTarget("confirm").status).toBe("not-ready");
		dom.query("#prompt").removeAttribute("hidden");
		const result = adapter.resignTarget("confirm");
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.target.rect.left).toBe(CONFIRM_RECT.x);
		expect(clicks).toEqual([]);
	});

	it("a popup with no known class names is found by what appeared after the resign click, never its Cancel", () => {
		const { dom, adapter, clicks } = boot();
		expect(adapter.resignTarget("resign").status).toBe("ready");
		// chess.com's real prompt: a dialog that did not exist before, arbitrary classes, two buttons.
		dom.document.body.insertAdjacentHTML(
			"beforeend",
			'<div id="popup" class="xyz-prompt" role="dialog">' +
				'<button id="popup-cancel" class="xyz-a">Cancel</button>' +
				'<button id="popup-yes" class="xyz-b">Resign</button></div>'
		);
		dom.layout("#popup-cancel", { ...CONFIRM_RECT, x: 900 });
		dom.layout("#popup-yes", { ...CONFIRM_RECT, x: 700 });
		const result = adapter.resignTarget("confirm");
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.target.rect.left).toBe(700);
		expect(clicks).toEqual([]);
		// The point revalidation lands on that very button.
		expect(adapter.resignTarget("confirm", result.target.targetId, { x: 720, y: 630 }).status).toBe(
			"ready"
		);
	});

	it("a new control that only reads 'Resign' in a plain container is the confirmation, not the old control", () => {
		const { dom, adapter } = boot();
		expect(adapter.resignTarget("resign").status).toBe("ready");
		dom.document.body.insertAdjacentHTML(
			"beforeend",
			'<div id="bar" class="whatever"><button id="bar-no">No</button><button id="bar-resign">Resign</button></div>'
		);
		dom.layout("#bar-no", { ...CONFIRM_RECT, x: 900 });
		dom.layout("#bar-resign", { ...CONFIRM_RECT, x: 740 });
		const result = adapter.resignTarget("confirm");
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.target.rect.left).toBe(740);
	});

	it("a confirmation labelled 'Resign' is accepted once it is a different control", () => {
		const { dom, adapter } = boot();
		expect(adapter.resignTarget("resign").status).toBe("ready");
		dom.query("#prompt").removeAttribute("hidden");
		dom.query("#confirm").textContent = "Resign";
		const result = adapter.resignTarget("confirm");
		expect(result.status === "ready" && result.target.rect.left).toBe(CONFIRM_RECT.x);
	});

	it("skips disabled, hidden and inert controls", () => {
		const { dom, adapter } = boot();
		const resign = dom.query("#resign");
		resign.setAttribute("disabled", "");
		expect(adapter.resignTarget("resign").status).toBe("not-ready");
		resign.removeAttribute("disabled");
		resign.setAttribute("aria-busy", "true");
		expect(adapter.resignTarget("resign").status).toBe("not-ready");
		resign.removeAttribute("aria-busy");
		resign.setAttribute("style", "pointer-events:none");
		expect(adapter.resignTarget("resign").status).toBe("not-ready");
		resign.removeAttribute("style");
		expect(adapter.resignTarget("resign").status).toBe("ready");
	});

	it("a generic container button without a resign label is not accepted", () => {
		const { dom, adapter } = boot();
		dom.query("#resign").remove();
		expect(adapter.resignTarget("resign").status).toBe("not-ready");
		dom.query("#draw").setAttribute("title", "Resign game");
		expect(adapter.resignTarget("resign").status).toBe("ready");
	});

	it("revalidates by the id it handed out and by the element under the point", () => {
		const { dom, adapter } = boot();
		const first = adapter.resignTarget("resign");
		expect(first.status).toBe("ready");
		if (first.status !== "ready") return;
		const id = first.target.targetId;
		const inside = { x: RESIGN_RECT.x + 10, y: RESIGN_RECT.y + 10 };
		expect(adapter.resignTarget("resign", id, inside).status).toBe("ready");
		// Same element, same id on a repeated read.
		const again = adapter.resignTarget("resign");
		expect(again.status === "ready" && again.target.targetId).toBe(id);
		expect(adapter.resignTarget("resign", "some-other-id", inside).status).toBe("not-ready");
		expect(adapter.resignTarget("resign", id, { x: 5, y: 5 }).status).toBe("not-ready");
		// A replaced control gets a new id, so the old one no longer validates.
		dom.query("#resign").outerHTML = '<button id="resign" aria-label="Resign">Resign</button>';
		dom.layout("#resign", RESIGN_RECT);
		expect(adapter.resignTarget("resign", id, inside).status).toBe("not-ready");
		const fresh = adapter.resignTarget("resign");
		expect(fresh.status === "ready" && fresh.target.targetId !== id).toBe(true);
	});

	it("answers on the computer page too", () => {
		const { adapter } = boot("chesscom-computer");
		expect(adapter.resignTarget("resign").status).toBe("ready");
	});
});
