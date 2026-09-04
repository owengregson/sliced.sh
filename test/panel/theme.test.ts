// test/panel/theme.test.ts — `system` resolves from prefers-color-scheme; reduced motion follows
// the setting or the OS (Part I §10.2, Appendix F §8.4).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createThemeController, isReducedMotion, MEDIA_QUERIES } from "@panel/theme";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";

let sim: Simulator;
let panel: PanelContext;

beforeEach(async () => {
	sim = createSimulator();
	panel = await bootPanelContext(sim);
});
afterEach(async () => {
	await panel.teardown();
	await sim.dispose();
});

interface FakeQuery {
	matches: boolean;
	media: string;
	addEventListener(type: string, cb: () => void): void;
	removeEventListener(type: string, cb: () => void): void;
	set(matches: boolean): void;
}

function fakeMatchMedia(): { fn: (q: string) => MediaQueryList; queries: Map<string, FakeQuery> } {
	const queries = new Map<string, FakeQuery>();
	const fn = (media: string): MediaQueryList => {
		let q = queries.get(media);
		if (!q) {
			const listeners = new Set<() => void>();
			const target: FakeQuery = {
				matches: false,
				media,
				addEventListener: (_t, cb) => void listeners.add(cb),
				removeEventListener: (_t, cb) => void listeners.delete(cb),
				set(matches) {
					target.matches = matches;
					for (const cb of listeners) cb();
				},
			};
			queries.set(media, target);
			q = target;
		}
		return q as unknown as MediaQueryList;
	};
	return { fn, queries };
}

describe("theme controller", () => {
	it("applies explicit themes and resolves system from prefers-color-scheme, live", () => {
		const { fn, queries } = fakeMatchMedia();
		const root = document.body;
		const ctl = createThemeController(root, { matchMedia: fn });
		expect(root.dataset.theme).toBe("dark");
		ctl.apply({ theme: "light", reducedMotion: "system" });
		expect(root.dataset.theme).toBe("light");
		ctl.apply({ theme: "system", reducedMotion: "system" });
		expect(root.dataset.theme).toBe("dark");
		const seen: string[] = [];
		ctl.onChange((s) => seen.push(s.theme));
		queries.get(MEDIA_QUERIES.light)?.set(true);
		expect(root.dataset.theme).toBe("light");
		expect(ctl.theme).toBe("light");
		expect(seen).toEqual(["light"]);
		ctl.dispose();
		queries.get(MEDIA_QUERIES.light)?.set(false);
		expect(root.dataset.theme).toBe("light"); // disposed: no longer listening
	});

	it("reduced motion: setting overrides, system follows the media query, and isReducedMotion reads it", () => {
		const { fn, queries } = fakeMatchMedia();
		const root = document.body;
		const ctl = createThemeController(root, { matchMedia: fn });
		expect(ctl.reducedMotion).toBe(false);
		expect(isReducedMotion()).toBe(false);
		ctl.apply({ theme: "dark", reducedMotion: "on" });
		expect(root.dataset.reducedMotion).toBe("true");
		expect(isReducedMotion()).toBe(true);
		ctl.apply({ theme: "dark", reducedMotion: "off" });
		queries.get(MEDIA_QUERIES.reducedMotion)?.set(true);
		expect(isReducedMotion()).toBe(false);
		ctl.apply({ theme: "dark", reducedMotion: "system" });
		expect(isReducedMotion()).toBe(true);
		ctl.dispose();
	});
});
