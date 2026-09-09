// test/panel/components/move-card.test.ts — Appendix F §5.6 / §13.4: the play button is live
// only on a your-move card whose hand is armed (the debugger attaches at arm time, never
// mid-game — an unarmed "Play move" would be refused by the service worker).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMoveCard, type MoveCardHandle } from "@panel/components/move-card";
import { COPY } from "@panel/copy";
import { bootPanelDom, click, mount, type PanelDom } from "../dom";

let dom: PanelDom;
let card: MoveCardHandle | null = null;

const button = (): HTMLElement => {
	if (!card) throw new Error("no card");
	return card.button.el;
};
const disabled = (): boolean => button().getAttribute("aria-disabled") === "true";

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	card?.dispose();
	card = null;
	await dom.teardown();
});

describe("createMoveCard play button", () => {
	it("is disabled until the hand is armed, and re-locks when it disarms or the turn passes", () => {
		const plays: number[] = [];
		card = createMoveCard(mount(document.createElement("div")), { onPlay: () => plays.push(1) });

		// My move, hand unarmed: the button is a label and a keybind hint only.
		card.update({ state: "your-move", san: "Nf3", armed: false, kbd: COPY.keybind.keys.space });
		expect(button().querySelector(".sl-button__label")?.textContent).toBe(COPY.move.play);
		expect(button().querySelector(".sl-button__kbd")?.textContent).toBe(COPY.keybind.keys.space);
		expect(disabled()).toBe(true);
		click(button());
		expect(plays).toHaveLength(0);

		// Armed: live.
		card.update({ state: "your-move", san: "Nf3", armed: true });
		expect(disabled()).toBe(false);
		click(button());
		expect(plays).toHaveLength(1);

		// Disarmed again, and armed but not my move: locked either way.
		card.update({ state: "your-move", san: "Nf3", armed: false });
		expect(disabled()).toBe(true);
		card.update({ state: "opponent", san: "e5", armed: true });
		expect(disabled()).toBe(true);
		card.update({ state: "thinking", armed: true });
		expect(disabled()).toBe(true);
		click(button());
		expect(plays).toHaveLength(1);

		// Hands-off (§13.4) locks the armed button too.
		card.update({ state: "your-move", san: "Nf3", armed: true, handsOff: true });
		expect(disabled()).toBe(true);
		click(button());
		expect(plays).toHaveLength(1);
	});
});
