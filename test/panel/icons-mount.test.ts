// test/panel/icons-mount.test.ts — `data-icon` → ICONS classes + fa-fw (Part I §10.3).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ICON_CLASS, ICONS } from "@design/icons";
import { applyIcon, isIconName, mountIcons, setIcon } from "@panel/icons-mount";
import { bootPanelDom, type PanelDom } from "./dom";

let dom: PanelDom;

beforeEach(async () => {
	dom = await bootPanelDom(
		'<main id="app"><i class="sl-icon" data-icon="action.play"></i><i class="sl-icon sl-icon--lg" data-icon="nav.game"></i><i class="sl-icon" data-icon="nope"></i></main>'
	);
});
afterEach(async () => {
	await dom.teardown();
});

describe("icons", () => {
	it("mounts every data-icon with the registry classes and fa-fw, keeps sl-* modifiers, hides from AT", () => {
		const root = document.getElementById("app");
		if (!root) throw new Error("no root");
		expect(mountIcons(root)).toBe(2);
		const play = root.querySelector('[data-icon="action.play"]');
		expect(play?.className).toBe(`${ICON_CLASS} ${ICONS["action.play"]} fa-fw`);
		expect(play?.getAttribute("aria-hidden")).toBe("true");
		const game = root.querySelector('[data-icon="nav.game"]');
		expect(game?.classList.contains("sl-icon--lg")).toBe(true);
		expect(game?.classList.contains("fa-chess-knight")).toBe(true);
		const bad = root.querySelector('[data-icon="nope"]');
		expect(bad?.className).toBe("sl-icon"); // untouched, logged
	});

	it("setIcon swaps glyphs without accumulating classes; spin is opt-in", () => {
		const el = document.createElement("i");
		applyIcon(el, "status.idle");
		applyIcon(el, "status.thinking", { spin: true });
		expect(el.className).toBe(`${ICON_CLASS} ${ICONS["status.thinking"]} fa-fw fa-spin`);
		expect(el.classList.contains("fa-circle")).toBe(false);
		expect(setIcon(el, "not-a-name")).toBe(false);
		expect(isIconName("exec.drag")).toBe(true);
		expect(isIconName("exec.nope")).toBe(false);
	});
});
