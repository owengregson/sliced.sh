// test/panel/views/live-collapse.test.ts — Appendix F §8.2 height strategy (six discrete collapse
// steps in a fixed order, evaluated against the available height) and the §4.5 compact
// breakpoint at 320 px. The controller measures `.sl-app` (ResizeObserver when it fires, else
// the window `resize` event) and never scales fluidly.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TOKENS } from "@design/tokens.generated";
import { COPY } from "@panel/copy";
import {
	COLLAPSE_STEPS,
	collapseFor,
	LIVE_BUDGET,
	liveLayoutHeight,
} from "@panel/views/live/collapse";
import { bootPanelDom, type PanelDom } from "../dom";
import { idleSnapshot, type LiveHarness, liveSnapshot, mountLive } from "./live-harness";

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

describe("collapseFor (pure)", () => {
	it("transcribes the §8.2 budget: 612 px of live layout under a 44 px top bar at 3 lines", () => {
		expect(LIVE_BUDGET.topBar).toBe(TOKENS.size.control.lg);
		expect(liveLayoutHeight(3)).toBe(612);
		expect(COLLAPSE_STEPS).toEqual(["strip", "pv", "wdl", "strength", "move", "scroll"]);
	});

	it("walks the six steps in order until the layout fits", () => {
		const full = collapseFor(612, 3);
		expect(full).toEqual({
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
		expect(collapseFor(503, 3)).toMatchObject({ name: "wdl", pvMax: 1, wdlFolded: true }); // 48 + 16
		expect(collapseFor(440, 3).name).toBe("wdl");
		expect(collapseFor(439, 3)).toMatchObject({ name: "strength", strengthChip: true }); // 44 + 16
		expect(collapseFor(380, 3).name).toBe("strength");
		expect(collapseFor(379, 3)).toMatchObject({ name: "move", moveCompact: true }); // ~56
		expect(collapseFor(324, 3).name).toBe("move");
		expect(collapseFor(323, 3)).toMatchObject({ name: "scroll", scroll: true, moveCompact: true });
		// Never 0 rows while a line exists; a 1-line setting (556 px) skips the PV step.
		expect(collapseFor(556, 1).name).toBe("full");
		expect(collapseFor(500, 1)).toMatchObject({ name: "wdl", pvMax: 1 });
		expect(collapseFor(700, 5).name).toBe("full");
		expect(collapseFor(650, 5).name).toBe("strip"); // 668 − 52 = 616 fits
		expect(collapseFor(600, 5)).toMatchObject({ name: "pv", pvMax: 4 }); // 588 fits
	});
});

describe("mounted view", () => {
	it("720 → 640 → 560 → 480 hit four distinct states in the §8.2 order", async () => {
		resize(360, 720);
		h = await mountLive(dom.sim, liveSnapshot());
		expect(h.root.dataset.collapse).toBe("full");
		expect(h.q(".sl-live__strip").hidden).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);
		expect(h.q(".sl-live__eval").hidden).toBe(false);
		expect(h.q(".sl-live__eval-inline").hidden).toBe(true);
		expect(h.q(".sl-live__strength").hidden).toBe(false);
		expect(h.q(".sl-live__strength-chip").hidden).toBe(true);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(false);

		resize(360, 640); // available 596: the strip goes (560 fits)
		expect(h.root.dataset.collapse).toBe("strip");
		expect(h.q(".sl-live__strip").hidden).toBe(true);
		expect(h.qa(".sl-pv")).toHaveLength(3);

		resize(360, 560); // available 516: 3 → 2 → 1 lines (504 fits)
		expect(h.root.dataset.collapse).toBe("pv");
		expect(h.qa(".sl-pv")).toHaveLength(1);
		expect(h.q(".sl-live__eval").hidden).toBe(false);

		resize(360, 480); // available 436: WDL folds (440 does not fit), strength becomes a chip (380)
		expect(h.root.dataset.collapse).toBe("strength");
		expect(h.q(".sl-live__eval").hidden).toBe(true);
		expect(h.q(".sl-live__eval-inline").hidden).toBe(false);
		expect(h.q(".sl-live__eval-inline").textContent).toBe("+1.34");
		expect(h.q(".sl-live__eval-inline").getAttribute("title")).toContain("71");
		expect(h.q(".sl-live__strength").hidden).toBe(true);
		expect(h.q(".sl-live__strength-chip").hidden).toBe(false);
		expect(h.q(".sl-live__strength-chip").textContent).toBe(`1500 · ${COPY.personaName.balanced}`);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(false);

		resize(360, 400); // available 356: the move card compacts (324 fits)
		expect(h.root.dataset.collapse).toBe("move");
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(true);
		expect(h.root.classList.contains("sl-live--scroll")).toBe(false);

		resize(360, 360); // available 316: nothing left to fold — the view scrolls, card pinned
		expect(h.root.dataset.collapse).toBe("scroll");
		expect(h.root.classList.contains("sl-live--scroll")).toBe(true);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(true);

		resize(360, 720); // back up: every block returns
		expect(h.root.dataset.collapse).toBe("full");
		expect(h.q(".sl-live__strip").hidden).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);
		expect(h.q(".sl-live__strength-chip").hidden).toBe(true);
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

	it("compact at 320: two lines max, move-sm card, short Play label, ratings hidden", async () => {
		resize(320, 720);
		h = await mountLive(dom.sim, idleSnapshot());
		expect(h.root.classList.contains("sl-live--compact")).toBe(true);
		expect(h.qa(".sl-pv")).toHaveLength(2);
		expect(h.q(".sl-move").classList.contains("sl-move--compact")).toBe(true);
		expect(h.q(".sl-move__action .sl-button__label").textContent).toBe(COPY.move.playShort);
		expect(h.q(".sl-live__eval-inline").hidden).toBe(false);
		expect(h.q(".sl-live__eval").hidden).toBe(true);
		expect(h.root.dataset.collapse).toBe("full"); // width, not height, drove this
		resize(360, 720);
		expect(h.root.classList.contains("sl-live--compact")).toBe(false);
		expect(h.qa(".sl-pv")).toHaveLength(3);
		expect(h.q(".sl-move__action .sl-button__label").textContent).toBe(COPY.move.play);
	});
});
