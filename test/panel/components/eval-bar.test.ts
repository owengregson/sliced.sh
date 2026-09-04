// test/panel/components/eval-bar.test.ts — Appendix F §5.5 / §7.4: meter semantics, valuetext
// "White +1.34, 71% win, 22% draw, 7% loss", fill from win probability (not raw cp).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createEvalBar,
	type EvalBarHandle,
	formatScore,
	whiteShare,
} from "@panel/components/eval-bar";
import { bootPanelDom, mount, type PanelDom } from "../dom";

let dom: PanelDom;
let handle: EvalBarHandle | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	handle?.dispose();
	handle = null;
	await dom.teardown();
});

describe("formatScore / whiteShare", () => {
	it("formats centipawns and mates from White's point of view", () => {
		expect(formatScore({ cp: 134 })).toBe("+1.34");
		expect(formatScore({ cp: -50 })).toBe("−0.50");
		expect(formatScore({ cp: 0 })).toBe("0.00");
		expect(formatScore({ mate: 5 })).toBe("M5");
		expect(formatScore({ mate: -3 })).toBe("−M3");
	});
	it("maps WDL to White's expected score and falls back to a logistic on cp", () => {
		expect(whiteShare({ cp: 134 }, [0.71, 0.22, 0.07])).toBeCloseTo(0.82, 5);
		expect(whiteShare({ cp: 134 }, [710, 220, 70])).toBeCloseTo(0.82, 5); // per-mille accepted
		expect(whiteShare({ cp: 0 })).toBeCloseTo(0.5, 5);
		expect(whiteShare({ cp: 300 })).toBeGreaterThan(0.7);
		expect(whiteShare({ cp: 300 })).toBeLessThan(0.95); // ±3 is not pinned at the edge
		expect(whiteShare({ cp: -300 })).toBeLessThan(0.3);
		expect(whiteShare({ mate: 2 })).toBe(1);
		expect(whiteShare({ mate: -2 })).toBe(0);
	});
});

describe("createEvalBar", () => {
	it("is a meter with the spec's valuetext and a fill driven by win probability", () => {
		const el = mount(document.createElement("div"));
		handle = createEvalBar(el);
		const root = handle.el;
		expect(root.getAttribute("role")).toBe("meter");
		expect(root.getAttribute("aria-valuemin")).toBe("0");
		expect(root.getAttribute("aria-valuemax")).toBe("100");
		expect(root.classList.contains("sl-evalbar--neutral")).toBe(true);
		handle.update({ score: { cp: 134 }, wdl: [0.71, 0.22, 0.07] });
		expect(root.getAttribute("aria-valuetext")).toBe("White +1.34, 71% win, 22% draw, 7% loss");
		expect(root.getAttribute("aria-valuenow")).toBe("82");
		expect(root.querySelector<HTMLElement>(".sl-evalbar__white")?.style.height).toBe("82%");
		expect(root.classList.contains("sl-evalbar--neutral")).toBe(false);
		expect(root.classList.contains("sl-evalbar--live")).toBe(true);
		expect(root.querySelector(".sl-evalbar__divider")).not.toBeNull();
		expect(root.querySelector(".sl-evalbar__mate")?.hasAttribute("hidden")).toBe(true);
	});

	it("rounds percentages so they sum to 100 and stays White-relative for negative scores", () => {
		const el = mount(document.createElement("div"));
		handle = createEvalBar(el);
		handle.update({ score: { cp: -80 }, wdl: [0.333, 0.333, 0.334] });
		expect(handle.el.getAttribute("aria-valuetext")).toBe("White −0.80, 33% win, 33% draw, 34% loss");
		handle.update({ score: { cp: 0 }, wdl: [0.2, 0.6, 0.2] });
		expect(handle.el.getAttribute("aria-valuetext")).toBe("White 0.00, 20% win, 60% draw, 20% loss");
	});

	it("mate states pin the fill, show the label, and word the side", () => {
		const el = mount(document.createElement("div"));
		handle = createEvalBar(el);
		handle.update({ score: { mate: 5 } });
		expect(handle.el.getAttribute("aria-valuetext")).toBe("Mate in 5 for White");
		expect(handle.el.classList.contains("sl-evalbar--mate")).toBe(true);
		expect(handle.el.querySelector<HTMLElement>(".sl-evalbar__white")?.style.height).toBe("100%");
		const mate = handle.el.querySelector<HTMLElement>(".sl-evalbar__mate");
		expect(mate?.hasAttribute("hidden")).toBe(false);
		expect(mate?.textContent).toBe("M5");
		expect(mate?.dataset.side).toBe("white");
		handle.update({ score: { mate: -3 } });
		expect(handle.el.getAttribute("aria-valuetext")).toBe("Mate in 3 for Black");
		expect(handle.el.querySelector<HTMLElement>(".sl-evalbar__white")?.style.height).toBe("0%");
		expect(mate?.dataset.side).toBe("black");
	});

	it("marks blunder-sized jumps, stale and neutral states", () => {
		const el = mount(document.createElement("div"));
		handle = createEvalBar(el);
		handle.update({ score: { cp: 0 }, wdl: [0.2, 0.6, 0.2] });
		expect(handle.el.classList.contains("sl-evalbar--jump")).toBe(false);
		handle.update({ score: { cp: 600 }, wdl: [0.9, 0.08, 0.02] });
		expect(handle.el.classList.contains("sl-evalbar--jump")).toBe(true);
		handle.update({ score: { cp: 600 }, wdl: [0.9, 0.08, 0.02], stale: true });
		expect(handle.el.classList.contains("sl-evalbar--stale")).toBe(true);
		expect(handle.el.classList.contains("sl-evalbar--jump")).toBe(false);
		handle.update({ neutral: true });
		expect(handle.el.classList.contains("sl-evalbar--neutral")).toBe(true);
		expect(handle.el.querySelector<HTMLElement>(".sl-evalbar__white")?.style.height).toBe("50%");
		expect(handle.el.getAttribute("aria-valuenow")).toBe("50");
	});
});
