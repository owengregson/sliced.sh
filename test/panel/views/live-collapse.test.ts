// test/panel/views/live-collapse.test.ts — Appendix F §8.2 height strategy: six discrete collapse
// states in a fixed order, selected by the available height (viewport − top bar − banner, never
// the content box) against the §8.2 thresholds. Live primary status remains stable, while
// secondary session data stays available below it; compact breakpoint is 320 px.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TOKENS } from "@design/tokens.generated";
import { COPY } from "@panel/copy";
import {
	COLLAPSE_STEPS,
	type CollapseState,
	collapseFor,
	LIVE_BUDGET,
	liveLayoutHeight,
	SCROLL_BELOW_PX,
} from "@panel/views/live/collapse";
import { bootPanelDom, type PanelDom } from "../dom";
import { idleSnapshot, type LiveHarness, liveSnapshot, mountLive } from "./live-harness";

const LIVE_CSS = ["live.css", "workspace.css", "live-progress.css"]
	.map((file) => readFileSync(path.resolve(import.meta.dir, "../../../css/views", file), "utf8"))
	.join("\n");

let dom: PanelDom;
let h: LiveHarness | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	h?.teardown();
	h = null;
	await dom.teardown();
});

function resize(width: number, height: number): void {
	const w = window as unknown as { innerWidth: number; innerHeight: number };
	w.innerWidth = width;
	w.innerHeight = height;
	window.dispatchEvent(new Event("resize"));
}

const SCROLL: CollapseState = {
	level: 6,
	name: "scroll",
	stripHidden: true,
	pvMax: 1,
	wdlFolded: true,
	strengthChip: true,
	moveCompact: true,
	scroll: true,
};

describe("collapseFor (pure)", () => {
	it("transcribes the §8.2 budget: 612 px of live layout under a 44 px top bar at 3 lines", () => {
		expect(LIVE_BUDGET.topBar).toBe(TOKENS.size.control.lg);
		expect(liveLayoutHeight(3)).toBe(612);
		expect(COLLAPSE_STEPS).toEqual(["strip", "pv", "wdl", "strength", "move", "scroll"]);
		expect(SCROLL_BELOW_PX).toBe(480);
	});

	it("walks the six states in order against the §8.2 thresholds; below 480 always scrolls", () => {
		expect(collapseFor(612, 3)).toEqual({
			level: 0,
			name: "full",
			stripHidden: false,
			pvMax: 3,
			wdlFolded: false,
			strengthChip: false,
			moveCompact: false,
			scroll: false,
		});
		expect(collapseFor(611, 3).name).toBe("strip"); // saves 36 + 16
		expect(collapseFor(560, 3).name).toBe("strip");
		expect(collapseFor(559, 3)).toMatchObject({ name: "pv", pvMax: 2 }); // 28 each
		expect(collapseFor(532, 3)).toMatchObject({ name: "pv", pvMax: 2 });
		expect(collapseFor(531, 3)).toMatchObject({ name: "pv", pvMax: 1 });
		expect(collapseFor(504, 3)).toMatchObject({ name: "pv", pvMax: 1 });
		expect(collapseFor(503, 3)).toMatchObject({ name: "strength", pvMax: 1, wdlFolded: true });
		expect(collapseFor(480, 3).name).toBe("strength");
		// §8.2 step 6, literally: below 480 px of available height the view scrolls with every
		// step applied and the card pinned — whatever the arithmetic would otherwise reach.
		expect(collapseFor(479, 3)).toEqual(SCROLL);
		expect(collapseFor(439, 3)).toEqual(SCROLL);
		expect(collapseFor(0, 3)).toEqual(SCROLL);
		// Never 0 rows while a line exists; a 1-line setting (556 px) skips the PV step.
		expect(collapseFor(556, 1).name).toBe("full");
		expect(collapseFor(500, 1)).toMatchObject({ name: "strength", pvMax: 1 });
		// Five lines (668 px). WDL folds, but the fixed eval row remains; strength folds next.
		expect(collapseFor(700, 5).name).toBe("full");
		expect(collapseFor(650, 5).name).toBe("strip"); // 668 − 52 = 616 fits
		expect(collapseFor(600, 5)).toMatchObject({ name: "pv", pvMax: 4 }); // 588 fits
		expect(collapseFor(500, 5)).toMatchObject({ name: "strength", pvMax: 1 });
		expect(collapseFor(479, 5)).toEqual(SCROLL);
	});
});

describe("mounted view", () => {
	it("720 → 640 → 560 → 480 walk the six states in the §8.2 order (viewport-based)", async () => {
		resize(360, 720);
		h = await mountLive(dom.sim, liveSnapshot());
		expect(h.app.clientHeight).toBe(4000); // the content box is huge and must be ignored
		expect(h.root.dataset.collapse).toBe("full");
		expect(h.q(".sl-live__strip").hidden).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);
		expect(h.q(".sl-live__eval").hidden).toBe(false);
		expect(h.q(".sl-live__eval-inline").hidden).toBe(true);
		expect(h.q(".sl-live__strength").hidden).toBe(false);
		expect(h.q(".sl-live__strength-chip").hidden).toBe(true);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(false);
		expect(h.root.classList.contains("sl-live--scroll")).toBe(false);

		resize(360, 640); // available 596: the strip goes (560 fits)
		expect(h.root.dataset.collapse).toBe("strip");
		expect(h.q(".sl-live__strip").hidden).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);

		resize(360, 560); // available 516: 3 → 2 → 1 lines (504 fits)
		expect(h.root.dataset.collapse).toBe("pv");
		expect(h.qa(".sl-pv")).toHaveLength(1);
		expect(h.q(".sl-live__eval").hidden).toBe(false);

		resize(360, 540); // available 496: WDL and strength fold; the eval chip remains.
		expect(h.root.dataset.collapse).toBe("strength");
		expect(h.q(".sl-live__eval").hidden).toBe(false);
		expect(h.q(".sl-live__eval-inline").hidden).toBe(true);
		expect(h.q(".sl-live__eval-score").textContent).toBe("+1.34");
		expect(h.q(".sl-live__eval-chip").getAttribute("title")).toContain("71");
		expect(h.q(".sl-live__strength").hidden).toBe(false);
		// A banner appearing without a resize is picked up on the next snapshot render.
		const bannerSlot = h.app.querySelector<HTMLElement>(".sl-app__banner");
		if (!bannerSlot) throw new Error("no banner slot");
		Object.defineProperty(bannerSlot, "offsetHeight", { configurable: true, value: 40 });
		h.store.emit(liveSnapshot()); // available 456 < 480
		expect(h.root.dataset.collapse).toBe("scroll");
		Object.defineProperty(bannerSlot, "offsetHeight", { configurable: true, value: 0 });
		h.store.emit(liveSnapshot());
		expect(h.root.dataset.collapse).toBe("strength");

		resize(360, 480); // available 436 < 480: the view scrolls, everything folded, card pinned
		expect(h.root.dataset.collapse).toBe("scroll");
		expect(h.root.classList.contains("sl-live--scroll")).toBe(true);
		expect(h.q(".sl-live__strip").hidden).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(1);
		expect(h.q(".sl-live__eval").hidden).toBe(false);
		expect(h.q(".sl-live__strength").hidden).toBe(false);
		expect(h.q(".sl-live__strength-chip").hidden).toBe(true);
		expect(h.q(".sl-live__strength-chip").textContent).toBe(`1500 · ${COPY.personaName.balanced}`);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(true);
		// The meter stays beside the persistent numeral, including compact scrolling layouts.
		expect(h.q(".sl-live__eval-chip").contains(h.q(".sl-live__rail"))).toBe(true);
		expect(h.q(".sl-live__eval-chip").getAttribute("aria-label")).toBe(
			h.q(".sl-evalbar").getAttribute("aria-valuetext")
		);
		expect(h.q(".sl-live__eval-chip").getAttribute("aria-label")).toContain("71% win");
		// Both clocks remain together above the card; the main stack scrolls as one unit.
		expect(LIVE_CSS).toMatch(/\.sl-live--scroll \.sl-live__move[^{]*\{[^}]*position:\s*static/);
		expect(LIVE_CSS).toMatch(/\.sl-live \.sl-live__column[^{]*\{[^}]*display:\s*grid/);
		expect(h.q(".sl-live__column").contains(h.q(".sl-live__move"))).toBe(false);

		resize(360, 720); // back up: every block returns
		expect(h.root.dataset.collapse).toBe("full");
		expect(h.q(".sl-live__strip").hidden).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);
		expect(h.q(".sl-live__strength-chip").hidden).toBe(true);
		expect(h.root.classList.contains("sl-live--scroll")).toBe(false);
	});

	it("subtracts a banner's height from the available height", async () => {
		resize(360, 720);
		h = await mountLive(dom.sim, liveSnapshot());
		const banner = h.app.querySelector<HTMLElement>(".sl-app__banner");
		if (!banner) throw new Error("no banner slot");
		Object.defineProperty(banner, "offsetHeight", { configurable: true, value: 80 });
		resize(360, 720); // available 596
		expect(h.root.dataset.collapse).toBe("strip");
	});

	it("compact at 320: two lines max, move-sm card, short Play label; depth column at ≥ 420", async () => {
		resize(320, 720);
		h = await mountLive(dom.sim, idleSnapshot());
		expect(h.root.classList.contains("sl-live--compact")).toBe(true);
		expect(h.qa(".sl-pv")).toHaveLength(2);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(true);
		expect(h.q(".sl-move__action .sl-button__label").textContent).toBe(COPY.move.playShort);
		expect(h.q(".sl-live__eval-inline").hidden).toBe(true);
		expect(h.q(".sl-live__eval").hidden).toBe(false);
		expect(h.root.dataset.collapse).toBe("full"); // width, not height, drove this
		expect(h.q(".sl-pv__depth").hidden).toBe(true);
		resize(360, 720);
		expect(h.root.classList.contains("sl-live--compact")).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);
		expect(h.q(".sl-move__action .sl-button__label").textContent).toBe(COPY.move.play);
		expect(h.q(".sl-pv__depth").hidden).toBe(true);
		resize(420, 720);
		expect(h.q(".sl-pv__depth").hidden).toBe(false);
		expect(h.q(".sl-pv__depth").textContent).toBe(COPY.lines.depth(18));
	});
});
