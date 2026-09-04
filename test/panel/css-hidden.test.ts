// test/panel/css-hidden.test.ts — the `hidden` attribute must win over any author `display`
// on component parts (review finding 1): one global rule in base.css, no ad-hoc `[hidden]` rules.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createButton } from "@panel/components/button";
import { bootPanelDom, mount, type PanelDom } from "./dom";

const CSS_DIR = path.resolve(import.meta.dir, "../../css");
const read = (file: string): string => readFileSync(path.join(CSS_DIR, file), "utf8");

describe("[hidden] rule", () => {
	it("base.css carries one global [hidden] { display: none !important } rule", () => {
		const base = read("base.css");
		expect(base).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
	});

	it("components.css and views/*.css have no ad-hoc [hidden] display rules", () => {
		for (const file of [
			"components.css",
			"primitives.css",
			"views/login.css",
			"views/states.css",
			"views/live.css",
			"views/settings.css",
			"views/engine.css",
		]) {
			expect({ file, hidden: /\[hidden\]/.test(read(file)) }).toEqual({ file, hidden: false });
		}
	});
});

describe("hidden parts", () => {
	let dom: PanelDom;
	beforeEach(async () => {
		dom = await bootPanelDom();
	});
	afterEach(async () => {
		await dom.teardown();
	});

	it("a button without a kbd chip or armed ring keeps those parts hidden", () => {
		const host = mount(document.createElement("div"));
		const button = createButton(host, { label: "Play move", variant: "primary" });
		const kbd = button.el.querySelector<HTMLElement>(".sl-button__kbd");
		const ring = button.el.querySelector<HTMLElement>(".sl-button__ring");
		expect(kbd?.hidden).toBe(true);
		expect(ring?.hidden).toBe(true);
		expect(ring?.querySelector(".sl-ring")).toBeNull(); // created lazily on the first arm
		button.update({ kbd: "Space", armed: true });
		expect(kbd?.hidden).toBe(false);
		expect(kbd?.textContent).toBe("Space");
		expect(ring?.hidden).toBe(false);
		expect(ring?.querySelector(".sl-ring")).not.toBeNull();
		button.update({ kbd: null, armed: false });
		expect(kbd?.hidden).toBe(true);
		expect(ring?.hidden).toBe(true);
		button.dispose();
	});
});
