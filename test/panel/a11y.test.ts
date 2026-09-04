// test/panel/a11y.test.ts — Task 27: SAN → speech, accessible names on every interactive
// element, tab order (Appendix F §8.3), `Esc` priority, live-region announcements, theme and
// motion attributes across media states, and the vendored fonts / §8.4 CSS blocks.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { type PanelSnapshot, UI_TIMINGS } from "@core/constants";
import {
	accessibleName,
	announce,
	disposeLiveRegions,
	findUnnamedInteractive,
	mountLiveRegions,
	SHELL_TAB_REGIONS,
	sanToSpeech,
	tabRegionOf,
	tabSequence,
} from "@panel/a11y";
import { showBanner } from "@panel/components/banner";
import { createButton } from "@panel/components/button";
import { createChipGroup } from "@panel/components/chip";
import { createClock } from "@panel/components/clock";
import { createEmptyState } from "@panel/components/empty-state";
import { createEvalBar } from "@panel/components/eval-bar";
import { createInput } from "@panel/components/input";
import { createKeybindCapture } from "@panel/components/keybind";
import { createMoveCard, spellSan } from "@panel/components/move-card";
import { openPopover } from "@panel/components/popover";
import { createPvList } from "@panel/components/pv-list";
import { createSegment } from "@panel/components/segment";
import { createSlider } from "@panel/components/slider";
import { showToast } from "@panel/components/toast";
import { createToggle } from "@panel/components/toggle";
import { COPY } from "@panel/copy";
import { activeEscapeScope, registerEscape, resetEscapeHandlers } from "@panel/keys";
import { bootShell, type PanelShell } from "@panel/shell";
import type { PanelStore } from "@panel/store";
import { createThemeController, isReducedMotion, MEDIA_QUERIES } from "@panel/theme";
import { VIEW_NAMES, type View } from "@panel/view";
import { renderTokens } from "../../scripts/gen-tokens";
import { tokens } from "../../src/design/tokens";
import { bootPanelDom, key, type PanelDom } from "./dom";
import { makeSnapshot } from "./fixtures";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const FONT_DIR = path.join(ROOT, "assets", "fonts");
const FONT_BUDGET_BYTES = 260 * 1024;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

interface FakeStore extends PanelStore {
	emit(snapshot: PanelSnapshot): void;
}

function fakeStore(): FakeStore {
	let snapshot: PanelSnapshot | null = null;
	const subs = new Set<(s: PanelSnapshot) => void>();
	return {
		get snapshot() {
			return snapshot;
		},
		connected: true,
		subscribe(cb) {
			subs.add(cb);
			if (snapshot) cb(snapshot);
			return () => void subs.delete(cb);
		},
		onPortMessage: () => () => {},
		dispatch: () => Promise.reject(new Error("not wired")),
		refresh() {},
		dispose() {},
		emit(next) {
			snapshot = next;
			for (const cb of subs) cb(next);
		},
	};
}

interface FakeQuery {
	matches: boolean;
	media: string;
	addEventListener(type: string, cb: () => void): void;
	removeEventListener(type: string, cb: () => void): void;
	set(matches: boolean): void;
}

function fakeMatchMedia(initial: Partial<Record<string, boolean>> = {}): {
	fn: (q: string) => MediaQueryList;
	queries: Map<string, FakeQuery>;
} {
	const queries = new Map<string, FakeQuery>();
	const fn = (media: string): MediaQueryList => {
		let q = queries.get(media);
		if (!q) {
			const listeners = new Set<() => void>();
			const target: FakeQuery = {
				matches: initial[media] === true,
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

const app = (): HTMLElement => {
	const el = document.getElementById("app");
	if (!el) throw new Error("no #app");
	return el;
};

const describeEl = (el: Element): string =>
	`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ").join(".")}` : ""}`;

/** A view that mounts one of every interactive sl-ui component (the real views are Tasks 23–26). */
function kitchenSinkView(): View {
	return {
		mount(ctx) {
			const section = document.createElement("section");
			section.dataset.view = "live";
			ctx.container.append(section);
			const handles = [
				createButton(section, { label: COPY.move.play, icon: "action.play", kbd: "Space" }),
				createButton(section, { label: COPY.common.close, icon: "action.cancel" }),
				createToggle(section, {
					label: COPY.toggle.autoplay,
					checked: false,
					armed: true,
					onChange() {},
				}),
				createToggle(section, { label: COPY.toggle.highlight, checked: true, onChange() {} }),
				createChipGroup(section, {
					items: [
						{ id: "a", label: COPY.execution.drag },
						{ id: "b", label: COPY.execution.click },
					],
					value: "a",
					onChange() {},
				}),
				createSegment(section, {
					items: [
						{ id: "x", label: COPY.common.on },
						{ id: "y", label: COPY.common.off },
					],
					value: "x",
					ariaLabel: COPY.toggle.highlight,
					onChange() {},
				}),
				createSlider(section, {
					min: 0,
					max: 10,
					step: 1,
					value: 5,
					label: (v) => String(v),
					ariaLabel: COPY.strength.bands.club,
					onChange() {},
				}),
				createInput(section, {
					label: COPY.login.fieldLabel,
					placeholder: COPY.login.hint,
					trailing: { icon: "action.play", label: COPY.login.reveal, onClick() {} },
				}),
				createKeybindCapture(section, {
					label: COPY.keybind.actions.playMove,
					value: {
						key: " ",
						code: "Space",
						altKey: false,
						ctrlKey: false,
						metaKey: false,
						shiftKey: false,
					},
					global: false,
					onChange() {},
				}),
				createClock(section),
				createEvalBar(section),
				createPvList(section),
				createMoveCard(section),
				createEmptyState(section, {
					title: COPY.unsupported.title,
					body: COPY.unsupported.body,
					actions: [{ label: COPY.banner.openEngine }],
				}),
			];
			const pv = handles[11];
			if (pv && "update" in pv)
				(pv as ReturnType<typeof createPvList>).update({
					lines: [
						{ multipv: 1, score: { cp: 34 }, depth: 18, pvUci: ["g1f3"], pvSan: ["Nf3"] },
						{ multipv: 2, score: { cp: 12 }, depth: 18, pvUci: ["e2e4"], pvSan: ["e4"] },
					],
				});
			const card = handles[12] as ReturnType<typeof createMoveCard>;
			card.update({ state: "your-move", color: "w", san: "Nf3", uci: "g1→f3", kbd: "Space" });
			return () => {
				for (const h of handles) h.dispose();
				section.remove();
			};
		},
	};
}

let dom: PanelDom;
let shell: PanelShell | null = null;
let store: FakeStore;

beforeEach(async () => {
	dom = await bootPanelDom();
	store = fakeStore();
});
afterEach(async () => {
	shell?.dispose();
	shell = null;
	disposeLiveRegions();
	resetEscapeHandlers();
	await dom.teardown();
});

// ── SAN → speech (§7.4) ─────────────────────────────────────────────────────────────────────

describe("sanToSpeech", () => {
	it("spells pieces, captures, checks, mates, castling and promotion", () => {
		expect(sanToSpeech("Nf3")).toBe("knight f3");
		expect(sanToSpeech("e4")).toBe("e4");
		expect(sanToSpeech("O-O")).toBe("castles kingside");
		expect(sanToSpeech("O-O-O")).toBe("castles queenside");
		expect(sanToSpeech("0-0")).toBe("castles kingside");
		expect(sanToSpeech("O-O+")).toBe("castles kingside check");
		expect(sanToSpeech("O-O-O#")).toBe("castles queenside checkmate");
		expect(sanToSpeech("exd5+")).toBe("e takes d5 check");
		expect(sanToSpeech("Qxe7")).toBe("queen takes e7");
		expect(sanToSpeech("Bxf7+")).toBe("bishop takes f7 check");
		expect(sanToSpeech("Rxh8#")).toBe("rook takes h8 checkmate");
		expect(sanToSpeech("Kxe2")).toBe("king takes e2");
		expect(sanToSpeech("e8=Q#")).toBe("e8 promotes to queen checkmate");
		expect(sanToSpeech("e8=Q")).toBe("e8 promotes to queen");
		expect(sanToSpeech("exd8=N+")).toBe("e takes d8 promotes to knight check");
		expect(sanToSpeech("b1=R")).toBe("b1 promotes to rook");
		expect(sanToSpeech("a1=B")).toBe("a1 promotes to bishop");
		expect(sanToSpeech("e8Q")).toBe("e8 promotes to queen");
	});

	it("keeps disambiguation, strips annotations and tolerates junk", () => {
		expect(sanToSpeech("Nbd2")).toBe("knight b d2");
		expect(sanToSpeech("R1e2")).toBe("rook 1 e2");
		expect(sanToSpeech("Qh4xe1")).toBe("queen h4 takes e1");
		expect(sanToSpeech("Nf3!")).toBe("knight f3");
		expect(sanToSpeech("Nf3?!")).toBe("knight f3");
		expect(sanToSpeech(" e4 ")).toBe("e4");
		expect(sanToSpeech("")).toBe("");
		expect(sanToSpeech("--")).toBe("");
		expect(sanToSpeech("e.p.")).toBe("");
	});

	it("uses the copy table (the only place the piece words live)", () => {
		expect(sanToSpeech("Nf3")).toBe(`${COPY.a11y.pieces.N} f3`);
		expect(sanToSpeech("O-O")).toBe(COPY.a11y.castleKing);
		expect(sanToSpeech("exd5+")).toBe(`e ${COPY.a11y.takes} d5 ${COPY.a11y.check}`);
	});

	it("agrees with the move card's local spellSan on the §7.4 examples (single source at integration)", () => {
		for (const san of ["Nf3", "O-O", "O-O-O", "exd5+", "e8=Q#", "Qxe7", "Bxf7+", "e4", "Rxh8#"])
			expect(sanToSpeech(san)).toBe(spellSan(san));
	});
});

// ── accessible names ────────────────────────────────────────────────────────────────────────

describe("accessibleName / findUnnamedInteractive", () => {
	it("computes names from aria-labelledby, aria-label, labels, alt, text and title", () => {
		document.body.innerHTML = `
			<span id="lbl">Strength</span>
			<button id="a" aria-labelledby="lbl"></button>
			<button id="b" aria-label="Close"></button>
			<label for="c">License key</label><input id="c" />
			<button id="d"><img alt="Play" src="x.png" /></button>
			<button id="e"><i class="fa" aria-hidden="true"></i> Update</button>
			<button id="f" title="Dismiss"></button>
			<input id="g" placeholder="Search" />
			<button id="h"><i aria-hidden="true">x</i></button>
			<div id="i" role="switch" tabindex="0"></div>
			<a id="j" href="#">Renew</a>
			<div id="k" tabindex="0"><span hidden>secret</span></div>`;
		const byId = (id: string): Element => {
			const el = document.getElementById(id);
			if (!el) throw new Error(id);
			return el;
		};
		expect(accessibleName(byId("a"))).toBe("Strength");
		expect(accessibleName(byId("b"))).toBe("Close");
		expect(accessibleName(byId("c"))).toBe("License key");
		expect(accessibleName(byId("d"))).toBe("Play");
		expect(accessibleName(byId("e"))).toBe("Update");
		expect(accessibleName(byId("f"))).toBe("Dismiss");
		expect(accessibleName(byId("g"))).toBe("Search");
		expect(accessibleName(byId("h"))).toBe("");
		expect(accessibleName(byId("i"))).toBe("");
		expect(accessibleName(byId("j"))).toBe("Renew");
		expect(accessibleName(byId("k"))).toBe("");
		expect(findUnnamedInteractive(document.body).map((el) => el.id)).toEqual(["h", "i", "k"]);
	});

	it("every interactive element in the mounted shell, each registered view and the components is named", async () => {
		shell = bootShell(app(), {
			store,
			views: { live: kitchenSinkView(), waiting: kitchenSinkView() },
		});
		store.emit(makeSnapshot());
		await dom.tick(0);
		for (const name of VIEW_NAMES) {
			await shell.router.switch(name);
			await dom.tick(0);
			expect(shell.router.current).toBe(name);
			const unnamed = findUnnamedInteractive(app()).map(describeEl);
			expect({ view: name, unnamed }).toEqual({ view: name, unnamed: [] });
		}
		// Chrome outside the views: banner action, toast action, popover close.
		await shell.router.switch("waiting");
		await dom.tick(0);
		const banner = showBanner("warn", COPY.banner.detached, [
			{ label: COPY.banner.reattach, onClick() {} },
		]);
		const toast = showToast("warn", COPY.toast.playFailed, {
			label: COPY.banner.reattach,
			onClick() {},
		});
		const anchor = app().querySelector<HTMLElement>(".sl-segment__item");
		if (!anchor) throw new Error("no anchor");
		const content = document.createElement("p");
		content.textContent = COPY.strength.popoverFooter;
		const popover = openPopover(anchor, content, { title: COPY.strength.bands.club });
		await dom.tick(0);
		expect(findUnnamedInteractive(app()).map(describeEl)).toEqual([]);
		popover.close();
		toast.dismiss();
		banner.dismiss();
	});
});

// ── tab order (§8.3) ────────────────────────────────────────────────────────────────────────

describe("tab order", () => {
	it("is top bar → banner → content top-to-bottom → toast action, with no positive tabindex", async () => {
		shell = bootShell(app(), { store, views: { waiting: kitchenSinkView() } });
		store.emit(makeSnapshot());
		await dom.tick(0);
		const banner = showBanner("warn", COPY.banner.detached, [
			{ label: COPY.banner.reattach, onClick() {} },
		]);
		const toast = showToast("warn", COPY.toast.playFailed, {
			label: COPY.banner.reattach,
			onClick() {},
		});
		await dom.tick(0);

		expect(SHELL_TAB_REGIONS).toEqual(["topbar", "banner", "content", "toasts"]);
		const seq = tabSequence(app());
		expect(seq.length).toBeGreaterThan(6);
		for (const el of seq) expect(Number(el.getAttribute("tabindex") ?? "0")).toBeLessThanOrEqual(0);
		expect(
			app().querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')
		).toHaveLength(0);

		const regions = seq.map((el) => tabRegionOf(el, app()));
		expect(regions).not.toContain(null);
		const firstIndex = new Map<string, number>();
		regions.forEach((r, i) => {
			if (r && !firstIndex.has(r)) firstIndex.set(r, i);
		});
		expect([...firstIndex.keys()]).toEqual(["topbar", "banner", "content", "toasts"]);
		// Regions are contiguous: the sequence never returns to an earlier region.
		const ranks = regions.map((r) => SHELL_TAB_REGIONS.indexOf(r ?? "topbar"));
		for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1] ?? 0);
		// The top bar starts with the view switch's selected tab; the toast action is last.
		expect(seq[0]?.getAttribute("role")).toBe("tab");
		expect(seq[seq.length - 1]?.closest(".sl-toast")).not.toBeNull();
		// Content is DOM order (top-to-bottom): the sequence equals the query order.
		const content = app().querySelector<HTMLElement>(".sl-app__content");
		if (!content) throw new Error("no content");
		const inContent = seq.filter((el) => content.contains(el));
		expect(inContent).toEqual(tabSequence(content));
		toast.dismiss();
		banner.dismiss();
	});

	it("hands-off empties the tab sequence (content locked, switch disabled); game over restores it", async () => {
		shell = bootShell(app(), {
			store,
			views: { live: kitchenSinkView(), waiting: kitchenSinkView() },
		});
		store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(shell.handsOff).toBe(true);
		expect(app().querySelectorAll(".sl-app__content button").length).toBeGreaterThan(0);
		expect(tabSequence(app())).toEqual([]);
		store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		const regions = tabSequence(app()).map((el) => tabRegionOf(el, app()));
		expect(regions[0]).toBe("topbar");
		expect(regions).toContain("content");
	});
});

// ── Esc priority (§8.3) ─────────────────────────────────────────────────────────────────────

describe("Esc priority", () => {
	it("countdown → popover → capture, regardless of registration order", () => {
		const fired: string[] = [];
		const offCapture = registerEscape("capture", () => fired.push("capture"));
		const offPopover = registerEscape("popover", () => fired.push("popover"));
		const offCountdown = registerEscape("countdown", () => fired.push("countdown"));
		expect(activeEscapeScope()).toBe("countdown");
		key(document, "keydown", { key: "Escape", code: "Escape" });
		expect(fired).toEqual(["countdown"]);
		offCountdown();
		expect(activeEscapeScope()).toBe("popover");
		key(document, "keydown", { key: "Escape", code: "Escape" });
		expect(fired).toEqual(["countdown", "popover"]);
		offPopover();
		key(document, "keydown", { key: "Escape", code: "Escape" });
		expect(fired).toEqual(["countdown", "popover", "capture"]);
		offCapture();
		expect(activeEscapeScope()).toBeNull();
		const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		document.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
	});

	it("a running countdown outranks an open popover and a keybind capture (real components)", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const cancelled: string[] = [];
		const keybind = createKeybindCapture(host, {
			label: COPY.keybind.actions.playMove,
			value: null,
			global: false,
			onChange() {},
		});
		keybind.el.querySelector<HTMLElement>("button")?.click();
		expect(keybind.capturing).toBe(true);
		expect(activeEscapeScope()).toBe("capture");
		const anchor = document.createElement("button");
		anchor.textContent = COPY.common.close;
		host.append(anchor);
		const popover = openPopover(anchor, document.createElement("p"), { title: COPY.common.close });
		expect(activeEscapeScope()).toBe("popover");
		const card = createMoveCard(host, { onCancel: () => cancelled.push("countdown") });
		card.update({ state: "your-move", color: "w", san: "Nf3", uci: "g1→f3", armed: true });
		card.countdown(3_000, 4_000);
		expect(activeEscapeScope()).toBe("countdown");
		key(document, "keydown", { key: "Escape", code: "Escape" });
		expect(cancelled).toEqual(["countdown"]);
		expect(popover.open).toBe(true);
		expect(keybind.capturing).toBe(true);
		card.dispose();
		popover.close();
		keybind.dispose();
		host.remove();
	});
});

// ── live regions ────────────────────────────────────────────────────────────────────────────

describe("live regions", () => {
	it("the shell mounts visually-hidden polite and assertive regions", async () => {
		shell = bootShell(app(), { store });
		store.emit(makeSnapshot());
		await dom.tick(0);
		const polite = app().querySelector<HTMLElement>('.sl-app__live [aria-live="polite"]');
		const assertive = app().querySelector<HTMLElement>('.sl-app__live [aria-live="assertive"]');
		expect(polite?.classList.contains("sl-visually-hidden")).toBe(true);
		expect(assertive?.classList.contains("sl-visually-hidden")).toBe(true);
		expect(polite?.getAttribute("role")).toBe("status");
		expect(assertive?.getAttribute("role")).toBe("alert");
		expect(polite?.getAttribute("aria-atomic")).toBe("true");
		shell.dispose();
		shell = null;
		expect(app().querySelector(".sl-app__live")).toBeNull();
	});

	it("announce is debounced per politeness and re-announces identical text", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const unmount = mountLiveRegions(host);
		const polite = host.querySelector<HTMLElement>('[aria-live="polite"]');
		const assertive = host.querySelector<HTMLElement>('[aria-live="assertive"]');
		if (!polite) throw new Error("no polite region");
		// Record every textContent write so the clear-then-refill of a repeated text is visible
		// even though both timers fire inside one fake-clock advance.
		const writes: string[] = [];
		let proto: object | null = Object.getPrototypeOf(polite);
		let desc: PropertyDescriptor | undefined;
		while (proto && !desc) {
			desc = Object.getOwnPropertyDescriptor(proto, "textContent");
			proto = Object.getPrototypeOf(proto);
		}
		if (!desc?.get || !desc.set) throw new Error("no textContent accessor");
		const { get, set } = desc;
		Object.defineProperty(polite, "textContent", {
			configurable: true,
			get: () => get.call(polite),
			set: (v: string) => {
				writes.push(v);
				set.call(polite, v);
			},
		});
		announce("one");
		announce("two");
		announce("three");
		announce("now", "assertive");
		expect(polite?.textContent).toBe("");
		await dom.tick(UI_TIMINGS.announceDebounceMs - 1);
		expect(polite?.textContent).toBe("");
		await dom.tick(1);
		expect(polite.textContent).toBe("three");
		expect(assertive?.textContent).toBe("now");
		expect(writes).toEqual(["three"]); // one write for the burst of three
		// Same text again: the region is cleared and re-filled so AT speaks it a second time.
		announce("three");
		await dom.tick(0);
		expect(polite.textContent).toBe("three");
		await dom.tick(UI_TIMINGS.announceDebounceMs);
		expect(writes).toEqual(["three", "", "three"]);
		expect(polite.textContent).toBe("three");
		// A different text is written directly (no clearing round trip).
		announce("four");
		await dom.tick(UI_TIMINGS.announceDebounceMs);
		expect(writes).toEqual(["three", "", "three", "four"]);
		// Empty text clears; an announcement with no region mounted is a no-op.
		announce("");
		await dom.tick(UI_TIMINGS.announceDebounceMs);
		expect(polite.textContent).toBe("");
		unmount();
		expect(host.children).toHaveLength(0);
		announce("gone");
		await dom.tick(UI_TIMINGS.announceDebounceMs);
		expect(host.textContent).toBe("");
		host.remove();
	});
});

// ── theme / motion attributes across media states ───────────────────────────────────────────

describe("theme and motion attributes", () => {
	const display = (theme: "dark" | "light" | "system", reducedMotion: "system" | "on" | "off") =>
		makeSnapshot({
			settings: { display: { ...makeSnapshot().settings.display, theme, reducedMotion } },
		});

	it("no matchMedia: system resolves to dark and reduced motion off", async () => {
		shell = bootShell(app(), { store, matchMedia: () => null });
		store.emit(display("system", "system"));
		await dom.tick(0);
		expect(document.body.dataset.theme).toBe("dark");
		expect(document.body.dataset.reducedMotion).toBe("false");
		expect(isReducedMotion()).toBe(false);
	});

	it("OS prefers light + reduce: system follows both; explicit settings override", async () => {
		const { fn, queries } = fakeMatchMedia({
			[MEDIA_QUERIES.light]: true,
			[MEDIA_QUERIES.reducedMotion]: true,
		});
		shell = bootShell(app(), { store, matchMedia: fn });
		store.emit(display("system", "system"));
		await dom.tick(0);
		expect(document.body.dataset.theme).toBe("light");
		expect(document.body.dataset.reducedMotion).toBe("true");
		expect(isReducedMotion()).toBe(true);
		store.emit(display("dark", "off"));
		await dom.tick(0);
		expect(document.body.dataset.theme).toBe("dark");
		expect(document.body.dataset.reducedMotion).toBe("false");
		expect(isReducedMotion()).toBe(false);
		// Back to system, then the OS flips both queries live.
		store.emit(display("system", "system"));
		await dom.tick(0);
		queries.get(MEDIA_QUERIES.light)?.set(false);
		queries.get(MEDIA_QUERIES.reducedMotion)?.set(false);
		expect(document.body.dataset.theme).toBe("dark");
		expect(document.body.dataset.reducedMotion).toBe("false");
	});

	it("OS prefers dark + no-preference: system is dark/off; `on` forces reduced motion", async () => {
		const { fn } = fakeMatchMedia();
		shell = bootShell(app(), { store, matchMedia: fn });
		store.emit(display("system", "system"));
		await dom.tick(0);
		expect(document.body.dataset.theme).toBe("dark");
		expect(document.body.dataset.reducedMotion).toBe("false");
		store.emit(display("light", "on"));
		await dom.tick(0);
		expect(document.body.dataset.theme).toBe("light");
		expect(document.body.dataset.reducedMotion).toBe("true");
		expect(isReducedMotion()).toBe(true);
	});

	it("the controller alone writes both attributes on its root", () => {
		const root = document.createElement("div");
		const ctl = createThemeController(root, { matchMedia: fakeMatchMedia().fn });
		expect(root.dataset.theme).toBe("dark");
		expect(root.dataset.reducedMotion).toBe("false");
		ctl.apply({ theme: "system", reducedMotion: "on" });
		expect(root.dataset.reducedMotion).toBe("true");
		expect(isReducedMotion(root)).toBe(true);
		ctl.dispose();
	});
});

// ── fonts and §8.4 CSS ──────────────────────────────────────────────────────────────────────

const familyName = (stack: string): string => {
	const m = /^"([^"]+)"/.exec(stack);
	if (!m?.[1]) throw new Error(`no quoted family in ${stack}`);
	return m[1];
};

describe("fonts", () => {
	const base = readFileSync(path.join(ROOT, "css", "base.css"), "utf8");
	const faces = [...base.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
	const families = ["ui", "display", "mono"].map((k) =>
		familyName(tokens.type.family[k as keyof typeof tokens.type.family])
	);

	it("declares one @font-face per Lattice family with font-display: swap and ../assets/fonts urls", () => {
		expect(families).toEqual(["Geist", "Bricolage Grotesque", "Geist Mono"]);
		expect(faces.length).toBeGreaterThanOrEqual(3);
		for (const family of families) {
			const face = faces.find((f) => f.includes(`font-family: "${family}"`));
			expect({ family, found: face !== undefined }).toEqual({ family, found: true });
			expect(face).toContain("font-display: swap");
			expect(face).toMatch(
				/src:\s*url\("\.\.\/assets\/fonts\/[A-Za-z-]+\.woff2"\)\s*format\("woff2"\)/
			);
			const weight = /font-weight:\s*(\d+)\s+(\d+)/.exec(face ?? "");
			expect(weight).not.toBeNull();
			const [lo, hi] = [Number(weight?.[1]), Number(weight?.[2])];
			expect(lo).toBe(tokens.type.weight.regular);
			expect(hi).toBe(
				family === "Geist Mono" ? tokens.type.weight.medium : tokens.type.weight.semibold
			);
		}
	});

	it("every referenced woff2 exists, is a WOFF2 file, and the set stays within the 260 KB budget", () => {
		const referenced = [...base.matchAll(/url\("\.\.\/assets\/fonts\/([A-Za-z-]+\.woff2)"\)/g)].map(
			(m) => m[1] ?? ""
		);
		expect(referenced.length).toBeGreaterThanOrEqual(3);
		const onDisk = readdirSync(FONT_DIR)
			.filter((f) => f.endsWith(".woff2"))
			.sort();
		expect(onDisk).toEqual([...new Set(referenced)].sort());
		let total = 0;
		for (const f of onDisk) {
			const p = path.join(FONT_DIR, f);
			total += statSync(p).size;
			expect(readFileSync(p).subarray(0, 4).toString("latin1")).toBe("wOF2");
		}
		expect(total).toBeLessThanOrEqual(FONT_BUDGET_BYTES);
		expect(total).toBeGreaterThan(0);
	});

	it("ships the OFL text for each family", () => {
		const licences = readdirSync(FONT_DIR).filter((f) => /^LICENSE-.*\.txt$/.test(f));
		expect(licences.sort()).toEqual([
			"LICENSE-BricolageGrotesque.txt",
			"LICENSE-Geist.txt",
			"LICENSE-GeistMono.txt",
		]);
		for (const f of licences)
			expect(readFileSync(path.join(FONT_DIR, f), "utf8")).toContain(
				"SIL OPEN FONT LICENSE Version 1.1"
			);
	});
});

describe("§8.4 preference blocks", () => {
	const base = readFileSync(path.join(ROOT, "css", "base.css"), "utf8");
	const components = readFileSync(path.join(ROOT, "css", "components.css"), "utf8");

	it("base.css: reduced motion, forced colours and more-contrast blocks are present", () => {
		expect(base).toContain("@media (prefers-reduced-motion: reduce)");
		expect(base).toContain('[data-reduced-motion="true"]');
		expect(base).toContain("@media (forced-colors: active)");
		expect(base).toContain("@media (prefers-contrast: more)");
		expect(base).toMatch(/--sl-color-border-subtle:\s*var\(--sl-color-border-strong\)/);
	});

	it("components.css: eval bar in CanvasText/Canvas, armed outline in Highlight, brand fills as ButtonFace", () => {
		const forced = components.slice(components.indexOf("@media (forced-colors: active)"));
		expect(forced).toMatch(/\.sl-evalbar__track\s*\{[^}]*background:\s*Canvas;/);
		expect(forced).toMatch(/\.sl-evalbar__white\s*\{[^}]*background:\s*CanvasText;/);
		expect(forced).toMatch(/\.sl-evalbar__divider\s*\{[^}]*background:\s*CanvasText;/);
		expect(forced).toMatch(/outline:\s*calc\(var\(--sl-hairline\) \* 2\) solid Highlight/);
		expect(forced).toMatch(/background:\s*ButtonFace;\s*color:\s*ButtonText;/);
		const reduced = components.slice(components.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toMatch(
			/\.sl-toggle--armed \.sl-toggle__track::after\s*\{[^}]*opacity:\s*0\.32;/
		);
	});

	it("tokens.css: prefers-contrast maps text-secondary to charcoal.300", () => {
		const { css } = renderTokens();
		const start = css.indexOf("@media (prefers-contrast: more)");
		expect(start).toBeGreaterThan(-1);
		const block = css.slice(start, css.indexOf("}\n}", start));
		expect(block.replace(/\s+/g, "")).toContain(
			`--sl-color-text-secondary:${tokens.color.palette["charcoal.300"]}`
		);
	});
});
