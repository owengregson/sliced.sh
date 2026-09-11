// test/panel/views/settings.test.ts — Task 25: the Settings view (Appendix F §4.6 / §7.2).
// Every `Settings` leaf has a row; hands-off disables the whole view; a row change writes the
// clamped value through `setSettings`; jump chips follow the scroll (IntersectionObserver);
// strength labels per band and the ≥ 2600 warning; timing presets pre-select the detected time
// control; keybind rows swap on conflict; the TTS voice select follows `display.tts`; the license
// reveal re-masks after 10 s; reset confirms; the footer shows version and build.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_KEYBINDS,
	DEFAULT_SETTINGS,
	LIMITS,
	LOCAL_KEYS,
	MSG,
	type PanelSnapshot,
	STRENGTH_LABEL_BANDS,
	UI_TIMINGS,
} from "@core/constants";
import { normalizeSettings, type SettingsPatch } from "@core/storage/settings-storage";
import { COPY, SETTINGS_COPY } from "@panel/copy";
import type { PanelStore } from "@panel/store";
import type { PanelUiState, Router, View, ViewContext } from "@panel/view";
import { VIEWS } from "@panel/views";
import { createSettingsView } from "@panel/views/settings";
import {
	clampRowValue,
	ROWS,
	type SettingsLeafPath,
	strengthBand,
	strengthLabel,
	tcClass,
} from "@panel/views/settings/rows";
import { SECTIONS } from "@panel/views/settings/sections";
import type { Keybind, Settings } from "@typedefs/settings";
import { bootPanelDom, click, key, type PanelDom } from "../dom";
import { makeSnapshot } from "../fixtures";

// ── harness ───────────────────────────────────────────────────────────────────────────────

interface FakeStore extends PanelStore {
	emit(snapshot: PanelSnapshot): void;
	readonly dispatched: string[];
}

function fakeStore(initial: PanelSnapshot): FakeStore {
	let snapshot: PanelSnapshot = initial;
	const subs = new Set<(s: PanelSnapshot) => void>();
	const dispatched: string[] = [];
	return {
		get snapshot() {
			return snapshot;
		},
		connected: true,
		dispatched,
		subscribe(cb) {
			subs.add(cb);
			cb(snapshot);
			return () => void subs.delete(cb);
		},
		onPortMessage: () => () => {},
		dispatch: (command) => {
			dispatched.push(command.type);
			return Promise.resolve([] as never);
		},
		refresh() {},
		dispose() {},
		emit(next) {
			snapshot = next;
			for (const cb of subs) cb(next);
		},
	};
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function merge(base: Obj, patch: Obj): Obj {
	const out: Obj = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		const b = out[k];
		out[k] = isObj(v) && isObj(b) ? merge(b, v) : v;
	}
	return out;
}

interface Harness {
	root: HTMLElement;
	store: FakeStore;
	patches: SettingsPatch[];
	settings(): Settings;
	cleanup(): void;
}

let dom: PanelDom;
let harness: Harness | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	harness?.cleanup();
	harness = null;
	await dom.teardown();
});

const noRouter: Router = {
	switch: () => Promise.resolve(),
	resolve: () => Promise.resolve(),
	current: "settings",
};

async function mountSettings(
	snapshot: PanelSnapshot = makeSnapshot(),
	options: { view?: View } = {}
): Promise<Harness> {
	const content = document.createElement("div");
	content.className = "sl-app__content";
	document.body.append(content);
	const store = fakeStore(snapshot);
	const patches: SettingsPatch[] = [];
	let current: Settings = normalizeSettings(snapshot.settings);
	const view =
		options.view ??
		createSettingsView({
			setSettings: async (patch) => {
				patches.push(patch);
				current = normalizeSettings(merge(current as unknown as Obj, patch as Obj));
				return current;
			},
		});
	const ui: PanelUiState = { tab: "settings", updateAvailable: false, updateDismissed: false };
	const controller = new AbortController();
	const ctx: ViewContext = {
		router: noRouter,
		container: content,
		store,
		snapshot,
		ui,
		signal: controller.signal,
	};
	const cleanup = await view.mount(ctx);
	await dom.tick(0);
	const root = content.querySelector<HTMLElement>('[data-view="settings"]');
	if (!root) throw new Error("settings view did not mount");
	harness = {
		root,
		store,
		patches,
		settings: () => current,
		cleanup() {
			cleanup();
			controller.abort();
			content.remove();
		},
	};
	return harness;
}

const row = (root: HTMLElement, path: SettingsLeafPath): HTMLElement => {
	const el = root.querySelector<HTMLElement>(`[data-path="${path}"]`);
	if (!el) throw new Error(`no row for ${path}`);
	return el;
};
const q = <T extends HTMLElement>(root: ParentNode, selector: string): T => {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	return el;
};
const isKeybind = (v: unknown): v is Keybind =>
	isObj(v) && typeof v.key === "string" && typeof v.code === "string";

/** Every leaf path of a settings object; a `Keybind` counts as one leaf. */
function leafPaths(value: unknown, prefix = ""): string[] {
	if (!isObj(value) || isKeybind(value)) return [prefix];
	return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────

describe("settings view · rows", () => {
	it("every setting in DEFAULT_SETTINGS has a row (a new setting without one fails here)", async () => {
		const h = await mountSettings();
		// Legacy automatic speech is retained in storage, but deliberately has no UI control.
		const paths = leafPaths(DEFAULT_SETTINGS).filter((path) => path !== "display.tts");
		expect(h.root.querySelector('[data-path="display.tts"]')).toBeNull();
		expect(paths.length).toBeGreaterThan(40);
		for (const path of paths) {
			expect(h.root.querySelector(`[data-path="${path}"]`), `row for ${path}`).not.toBeNull();
		}
		// The declarative table and the section layout agree with each other and with the schema.
		const tablePaths = new Set<string>(ROWS.map((r) => r.path));
		expect([...tablePaths].sort()).toEqual([...paths].sort());
		const laidOut: string[] = SECTIONS.flatMap((s) => s.rows);
		expect([...laidOut].sort()).toEqual([...tablePaths].sort());
		expect(SECTIONS.map((s) => s.id)).toEqual([
			"strength",
			"timing",
			"execution",
			"keybinds",
			"display",
			"account",
			"advanced",
		]);
		for (const section of SECTIONS) {
			const el = h.root.querySelector(`[data-section="${section.id}"]`);
			expect(el?.querySelector(".sl-section__title")?.textContent).toBe(section.title);
		}
		// V2.1 additions and their copy.
		expect(row(h.root, "strength.matchOpponentRating").querySelector("[role=switch]")).not.toBeNull();
		expect(row(h.root, "strength.personaEloOffset").querySelector("[role=slider]")).not.toBeNull();
		expect(
			row(h.root, "execution.previewSelects").querySelectorAll(".sl-segment__item")
		).toHaveLength(2);
		expect(row(h.root, "execution.previewSelectScale").querySelector("[role=slider]")).not.toBeNull();
		const highlight = row(h.root, "automation.highlightMoves");
		expect(highlight.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe(
			String(DEFAULT_SETTINGS.automation.highlightMoves)
		);
		expect(highlight.querySelector(".sl-settings-row__help")?.textContent).toBe(
			SETTINGS_COPY.rows["automation.highlightMoves"].help
		);
		expect(
			row(h.root, "execution.calibrateFromMyMouse").querySelector("[role=switch]")
		).not.toBeNull();
		expect(
			row(h.root, "execution.keepDebuggerAttached").querySelector(".sl-settings-row__help")
				?.textContent
		).toBe(COPY.execution.debugger);
		// The registry entry is the real view.
		expect(VIEWS.settings).not.toBeUndefined();
		const content = document.createElement("div");
		document.body.append(content);
		const cleanup = await VIEWS.settings.mount({
			router: noRouter,
			container: content,
			store: h.store,
			snapshot: h.store.snapshot,
			ui: { tab: "settings", updateAvailable: false, updateDismissed: false },
			signal: new AbortController().signal,
		});
		expect(content.querySelector(".sl-settings")).not.toBeNull();
		cleanup();
		content.remove();
	});

	it("changing a row writes the clamped value through setSettings and reflects the stored result", async () => {
		const h = await mountSettings();
		// Toggle → boolean patch.
		click(q(row(h.root, "strength.useOpeningBook"), "[role=switch]"));
		await dom.tick(0);
		expect(h.patches).toEqual([{ strength: { useOpeningBook: false } }]);
		// Slider: End goes to the table max, which is the LIMITS clamp.
		key(q(row(h.root, "strength.targetElo"), "[role=slider]"), "keydown", { key: "End" });
		await dom.tick(0);
		expect(h.patches[1]).toEqual({ strength: { targetElo: LIMITS.eloMax } });
		// Stepper: + at the max is a no-op write-wise; − steps down by one.
		const pv = row(h.root, "display.pvCount");
		for (let i = 0; i < LIMITS.multiPvMax + 2; i++) click(q(pv, ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.settings().display.pvCount).toBe(LIMITS.multiPvMax);
		expect(q(pv, ".sl-stepper__value").textContent).toBe(String(LIMITS.multiPvMax));
		click(q(pv, ".sl-stepper__button--dec"));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ display: { pvCount: LIMITS.multiPvMax - 1 } });
		// Chips and segments → enum patches.
		click(q(row(h.root, "strength.persona"), '.sl-chip[data-value="aggressive"]'));
		click(q(row(h.root, "execution.backend"), '.sl-segment__item[data-value="native"]'));
		await dom.tick(0);
		expect(h.patches.at(-2)).toEqual({ strength: { persona: "aggressive" } });
		expect(h.patches.at(-1)).toEqual({ execution: { backend: "native" } });
		// Select → string patch; threads stepper below 1 means "auto".
		const level = q<HTMLSelectElement>(row(h.root, "advanced.logLevel"), "select");
		level.value = "debug";
		level.dispatchEvent(new Event("change", { bubbles: true }));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ advanced: { logLevel: "debug" } });
		const threads = row(h.root, "engine.threads");
		expect(q(threads, ".sl-stepper__value").textContent).toBe(SETTINGS_COPY.format.threadsAuto);
		click(q(threads, ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ engine: { threads: 1 } });
		click(q(threads, ".sl-stepper__button--dec"));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ engine: { threads: "auto" } });
		// The pure clamp used by the view follows LIMITS.
		expect(clampRowValue("strength.targetElo", 99_999)).toBe(LIMITS.eloMax);
		expect(clampRowValue("strength.targetElo", -5)).toBe(LIMITS.eloMin);
		expect(clampRowValue("engine.hashMb", 1)).toBe(LIMITS.hashMbMin);
		expect(clampRowValue("display.pvCount", 3.4)).toBe(3);
		// A snapshot from the SW re-renders the controls.
		h.store.emit(
			makeSnapshot({
				settings: { display: { ...DEFAULT_SETTINGS.display, pvCount: 2, evalBar: false } },
			})
		);
		await dom.tick(0);
		expect(q(row(h.root, "display.pvCount"), ".sl-stepper__value").textContent).toBe("2");
		expect(q(row(h.root, "display.evalBar"), "[role=switch]").getAttribute("aria-checked")).toBe(
			"false"
		);
	});
});

describe("settings view · automatic queue delay", () => {
	it("enables dependent controls in order and preserves the chosen delay when auto-queue is off", async () => {
		const h = await mountSettings();
		const queue = q(row(h.root, "automation.autoQueue"), "[role=switch]");
		const delay = q(row(h.root, "automation.autoQueueDelayEnabled"), "[role=switch]");
		const maxRow = row(h.root, "automation.autoQueueDelayMaxMinutes");
		const max = q(maxRow, ".sl-stepper");
		const increment = q(maxRow, ".sl-stepper__button--inc");
		expect(delay.getAttribute("aria-disabled")).toBe("true");
		expect(max.getAttribute("aria-disabled")).toBe("true");
		expect(q(maxRow, ".sl-stepper__value").textContent).toBe("5 min");
		click(delay);
		click(increment);
		await dom.tick(0);
		expect(h.patches).toEqual([]);

		click(queue);
		await dom.tick(0);
		expect(delay.getAttribute("aria-disabled")).toBeNull();
		expect(max.getAttribute("aria-disabled")).toBe("true");
		click(delay);
		await dom.tick(0);
		expect(max.getAttribute("aria-disabled")).toBeNull();
		click(increment);
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ automation: { autoQueueDelayMaxMinutes: 6 } });
		expect(q(maxRow, ".sl-stepper__value").textContent).toBe("6 min");

		click(queue);
		await dom.tick(0);
		expect(delay.getAttribute("aria-disabled")).toBe("true");
		expect(max.getAttribute("aria-disabled")).toBe("true");
		expect(h.settings().automation.autoQueueDelayEnabled).toBe(true);
		expect(h.settings().automation.autoQueueDelayMaxMinutes).toBe(6);
		click(queue);
		await dom.tick(0);
		expect(max.getAttribute("aria-disabled")).toBeNull();
		click(delay);
		await dom.tick(0);
		expect(max.getAttribute("aria-disabled")).toBe("true");
		expect(h.settings().automation.autoQueueDelayMaxMinutes).toBe(6);
	});

	it("bounds the delay stepper and follows external dependency changes", async () => {
		const automation = {
			...DEFAULT_SETTINGS.automation,
			autoQueue: true,
			autoQueueDelayEnabled: true,
			autoQueueDelayMaxMinutes: LIMITS.autoQueueDelayMinutesMax,
		};
		const h = await mountSettings(makeSnapshot({ settings: { automation } }));
		const maxRow = row(h.root, "automation.autoQueueDelayMaxMinutes");
		expect(q(maxRow, ".sl-stepper__button--inc").getAttribute("aria-disabled")).toBe("true");
		click(q(maxRow, ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.patches).toEqual([]);
		h.store.emit(
			makeSnapshot({
				settings: { automation: { ...automation, autoQueueDelayMaxMinutes: 1 } },
			})
		);
		expect(q(maxRow, ".sl-stepper__button--dec").getAttribute("aria-disabled")).toBe("true");
		expect(q(maxRow, ".sl-stepper__value").textContent).toBe("1 min");
		h.store.emit(makeSnapshot({ settings: { automation: { ...automation, autoQueue: false } } }));
		expect(q(maxRow, ".sl-stepper").getAttribute("aria-disabled")).toBe("true");
		expect(clampRowValue("automation.autoQueueDelayMaxMinutes", 0)).toBe(1);
		expect(clampRowValue("automation.autoQueueDelayMaxMinutes", 999)).toBe(60);
	});
});

describe("settings view · hands-off", () => {
	it("a live game disables the whole view: root aria-disabled, every control inert", async () => {
		const h = await mountSettings(makeSnapshot({ state: "live:opponent-turn" }));
		expect(h.root.getAttribute("aria-disabled")).toBe("true");
		expect(h.root.classList.contains("sl-settings--locked")).toBe(true);
		const controls = h.root.querySelectorAll(
			".sl-toggle, .sl-slider__thumb, .sl-chip-group, .sl-segment, .sl-keybind, .sl-stepper, .sl-select, .sl-button"
		);
		expect(controls.length).toBeGreaterThan(30);
		for (const c of controls) expect(c.getAttribute("aria-disabled"), c.className).toBe("true");
		for (const s of h.root.querySelectorAll("select")) expect(s.disabled).toBe(true);
		click(q(row(h.root, "strength.useOpeningBook"), "[role=switch]"));
		key(q(row(h.root, "strength.targetElo"), "[role=slider]"), "keydown", { key: "End" });
		click(q(row(h.root, "display.pvCount"), ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.patches).toEqual([]);
		// Game over: the view unlocks from the next snapshot.
		h.store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		expect(h.root.getAttribute("aria-disabled")).toBeNull();
		expect(
			q(row(h.root, "strength.useOpeningBook"), "[role=switch]").getAttribute("aria-disabled")
		).toBeNull();
		click(q(row(h.root, "strength.useOpeningBook"), "[role=switch]"));
		await dom.tick(0);
		expect(h.patches).toEqual([{ strength: { useOpeningBook: false } }]);
		// Back into a game: locked again through the store.
		h.store.emit(makeSnapshot({ state: "live:my-turn:analysing" }));
		await dom.tick(0);
		expect(h.root.getAttribute("aria-disabled")).toBe("true");
	});

	it("an open confirm popover is closed when the game goes live; Confirm cannot act mid-game", async () => {
		const h = await mountSettings();
		click(q(h.root, ".sl-settings-advanced__reset"));
		const confirm = q(document, ".sl-popover .sl-settings-confirm__confirm");
		expect(document.querySelector(".sl-popover")).not.toBeNull();
		h.store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).toBeNull();
		click(confirm); // a stale reference must not fire either
		await dom.tick(0);
		expect(h.patches).toEqual([]);
		// Sign-out confirm: the same, and no logout is dispatched.
		h.store.emit(makeSnapshot({ state: "game-over" }));
		await dom.tick(0);
		click(q(h.root, ".sl-settings-account__signout"));
		expect(document.querySelector(".sl-popover")).not.toBeNull();
		h.store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).toBeNull();
		expect(h.store.dispatched).toEqual([]);
		// While locked the buttons open nothing.
		click(q(h.root, ".sl-settings-advanced__reset"));
		expect(document.querySelector(".sl-popover")).toBeNull();
	});
});

describe("settings view · jump chips", () => {
	it("scroll-spy follows the topmost visible section and is disposed on unmount", async () => {
		interface Entry {
			target: Element;
			isIntersecting: boolean;
		}
		const instances: Array<{
			cb: (entries: Entry[]) => void;
			observed: Element[];
			disconnected: boolean;
		}> = [];
		const g = globalThis as Record<string, unknown>;
		const saved = g.IntersectionObserver;
		class FakeIO {
			readonly record: (typeof instances)[number];
			constructor(cb: (entries: Entry[]) => void) {
				this.record = { cb, observed: [], disconnected: false };
				instances.push(this.record);
			}
			observe(el: Element): void {
				this.record.observed.push(el);
			}
			unobserve(): void {}
			disconnect(): void {
				this.record.disconnected = true;
			}
			takeRecords(): never[] {
				return [];
			}
		}
		g.IntersectionObserver = FakeIO;
		try {
			const h = await mountSettings();
			const io = instances[0];
			if (!io) throw new Error("no observer");
			expect(io.observed).toHaveLength(SECTIONS.length);
			const chips = q(h.root, ".sl-settings__jump .sl-chip-group");
			expect(chips.querySelectorAll(".sl-chip")).toHaveLength(SECTIONS.length);
			expect(
				chips.querySelector('.sl-chip[data-value="strength"]')?.getAttribute("aria-pressed")
			).toBe("true");
			const section = (id: string): Element => q(h.root, `[data-section="${id}"]`);
			io.cb([
				{ target: section("strength"), isIntersecting: false },
				{ target: section("timing"), isIntersecting: true },
				{ target: section("execution"), isIntersecting: true },
			]);
			expect(chips.querySelector('.sl-chip[data-value="timing"]')?.getAttribute("aria-pressed")).toBe(
				"true"
			);
			io.cb([{ target: section("timing"), isIntersecting: false }]);
			expect(
				chips.querySelector('.sl-chip[data-value="execution"]')?.getAttribute("aria-pressed")
			).toBe("true");
			// Clicking a chip selects it and asks the section to scroll into view.
			const scrolled: string[] = [];
			for (const s of SECTIONS) {
				(section(s.id) as HTMLElement).scrollIntoView = () => void scrolled.push(s.id);
			}
			click(q(chips, '.sl-chip[data-value="account"]'));
			expect(scrolled).toEqual(["account"]);
			expect(chips.querySelector('.sl-chip[data-value="account"]')?.getAttribute("aria-pressed")).toBe(
				"true"
			);
			h.cleanup();
			harness = null;
			expect(io.disconnected).toBe(true);
		} finally {
			g.IntersectionObserver = saved;
		}
	});
});

describe("settings view · strength", () => {
	it("labels the slider by band and warns from 2600", async () => {
		expect(STRENGTH_LABEL_BANDS.map((b) => b.band)).toEqual([
			"casual",
			"club",
			"expert",
			"master",
			"elite",
		]);
		expect(strengthBand(400)).toBe("casual");
		expect(strengthBand(799)).toBe("casual");
		expect(strengthBand(800)).toBe("club");
		expect(strengthBand(1399)).toBe("club");
		expect(strengthBand(1400)).toBe("expert");
		expect(strengthBand(1999)).toBe("expert");
		expect(strengthBand(2000)).toBe("master");
		expect(strengthBand(2599)).toBe("master");
		expect(strengthBand(2600)).toBe("elite");
		expect(strengthBand(3200)).toBe("elite");
		expect(strengthLabel(1200)).toBe("Club 1200");
		expect(strengthLabel(2650)).toBe("Elite 2650");

		const h = await mountSettings();
		const slider = row(h.root, "strength.targetElo");
		const thumb = q(slider, "[role=slider]");
		expect(thumb.getAttribute("aria-valuetext")).toBe("Expert 1500");
		expect(thumb.getAttribute("aria-valuemax")).toBe(String(LIMITS.eloMax));
		expect(q(slider, ".sl-slider__divider").dataset.value).toBe(String(LIMITS.nnueSmallEloMax));
		expect(q(slider, ".sl-slider__divider").style.left).toBe(
			`${(((LIMITS.nnueSmallEloMax - LIMITS.eloMin) / (LIMITS.eloMax - LIMITS.eloMin)) * 100).toFixed(3)}%`
		);
		expect(q(slider, ".sl-slider__boundary").textContent).toContain(COPY.strength.smallNetwork);
		expect(q(slider, ".sl-slider__boundary").textContent).toContain(COPY.strength.largeNetwork);
		expect(q(slider, ".sl-slider__bubble").textContent).toBe("Expert 1500");
		expect([...slider.querySelectorAll(".sl-slider__mark")].map((m) => m.textContent)).toEqual([
			COPY.strength.bands.casual,
			COPY.strength.bands.club,
			COPY.strength.bands.expert,
			COPY.strength.bands.master,
			COPY.strength.bands.elite,
		]);
		expect(q(slider, ".sl-slider__hint").hidden).toBe(true);
		key(thumb, "keydown", { key: "End" });
		expect(thumb.getAttribute("aria-valuetext")).toBe(`Elite ${LIMITS.eloMax}`);
		expect(q(slider, ".sl-slider").classList.contains("sl-slider--danger")).toBe(true);
		expect(q(slider, ".sl-slider__hint").hidden).toBe(false);
		expect(q(slider, ".sl-slider__hint").textContent).toBe(COPY.strength.warning);
		key(thumb, "keydown", { key: "Home" });
		expect(q(slider, ".sl-slider__hint").hidden).toBe(true);
		// The persona chips carry their descriptions.
		expect(row(h.root, "strength.persona").querySelector(".sl-settings-row__help")?.textContent).toBe(
			COPY.persona.balanced
		);
		click(q(row(h.root, "strength.persona"), '.sl-chip[data-value="cautious"]'));
		expect(row(h.root, "strength.persona").querySelector(".sl-settings-row__help")?.textContent).toBe(
			COPY.persona.cautious
		);
		expect(UI_TIMINGS.strengthDangerElo).toBe(2600);
	});
});

describe("settings view · timing presets", () => {
	it("maps time controls to classes (local mapping until @core/timing lands)", () => {
		expect(tcClass({ baseMs: 60_000, incMs: 0 })).toBe("bullet");
		expect(tcClass({ baseMs: 120_000, incMs: 1_000 })).toBe("bullet");
		expect(tcClass({ baseMs: 180_000, incMs: 2_000 })).toBe("blitz");
		expect(tcClass({ baseMs: 300_000, incMs: 0 })).toBe("blitz");
		expect(tcClass({ baseMs: 600_000, incMs: 0 })).toBe("rapid");
		expect(tcClass({ baseMs: 900_000, incMs: 10_000 })).toBe("rapid");
		expect(tcClass({ baseMs: 1_800_000, incMs: 0 })).toBe("classical");
	});

	it("pre-selects the detected time control's preset and notes overrides", async () => {
		const snapshot = makeSnapshot();
		snapshot.session.timeControl = { baseMs: 60_000, incMs: 0 };
		const h = await mountSettings(snapshot);
		const preset = row(h.root, "timing.profile");
		const chip = (id: string): HTMLElement => q(preset, `.sl-chip[data-value="${id}"]`);
		// Stored profile is "natural", detected bullet → "fast" is pre-selected and marked.
		expect(chip("fast").getAttribute("aria-pressed")).toBe("true");
		expect(chip("fast").dataset.detected).toBe("true");
		expect(chip("natural").getAttribute("aria-pressed")).toBe("false");
		expect(q(preset, ".sl-settings-row__note").textContent).toBe(COPY.timing.detected("bullet 1+0"));
		expect(h.patches).toEqual([]); // pre-selection is display only
		click(chip("slow"));
		await dom.tick(0);
		expect(h.patches).toEqual([{ timing: { profile: "slow" } }]);
		expect(q(preset, ".sl-settings-row__note").textContent).toBe(COPY.timing.overrides);
		expect(chip("fast").dataset.detected).toBe("true");
		// Manual shows the manual-only description.
		click(chip("manual"));
		await dom.tick(0);
		expect(q(preset, ".sl-settings-row__help").textContent).toBe(COPY.timing.manualOnly);
		expect(q(preset, ".sl-settings-row__help").hidden).toBe(false);
		// No detected time control: the stored profile is selected, no note.
		h.cleanup();
		harness = null;
		const plain = await mountSettings(makeSnapshot());
		const preset2 = row(plain.root, "timing.profile");
		expect(q(preset2, '.sl-chip[data-value="natural"]').getAttribute("aria-pressed")).toBe("true");
		expect(preset2.querySelector("[data-detected]")).toBeNull();
		expect(q(preset2, ".sl-settings-row__note").hidden).toBe(true);
		// A blitz 3+2 game formats as "blitz 3+2".
		plain.cleanup();
		harness = null;
		const blitz = makeSnapshot();
		blitz.session.timeControl = { baseMs: 180_000, incMs: 2_000 };
		const b = await mountSettings(blitz);
		expect(q(row(b.root, "timing.profile"), ".sl-settings-row__note").textContent).toBe(
			COPY.timing.detected("blitz 3+2")
		);
	});
});

describe("settings view · keybinds", () => {
	it("uses the capture component and swaps on conflict", async () => {
		const h = await mountSettings();
		const play = row(h.root, "keybinds.playMove");
		const speak = row(h.root, "keybinds.speakMove");
		expect(q(play, ".sl-keybind__key").textContent).toBe("Space");
		expect(q(speak, ".sl-keybind__key").textContent).toBe("W");
		click(q(play, ".sl-keybind__key"));
		key(document, "keydown", { key: "w", code: "KeyW" });
		key(document, "keyup", { key: "w", code: "KeyW" });
		expect(play.querySelector<HTMLElement>(".sl-keybind")?.dataset.state).toBe("conflict");
		expect(q(play, ".sl-keybind__hint").textContent).toBe(
			COPY.keybind.conflict(COPY.keybind.actions.speakMove)
		);
		expect(h.patches).toEqual([]);
		key(document, "keydown", { key: "Enter", code: "Enter" });
		await dom.tick(0);
		const w: Keybind = {
			key: "w",
			code: "KeyW",
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
		};
		expect(h.patches).toEqual([{ keybinds: { playMove: w, speakMove: DEFAULT_KEYBINDS.playMove } }]);
		expect(q(play, ".sl-keybind__key").textContent).toBe("W");
		expect(q(speak, ".sl-keybind__key").textContent).toBe("Space");
		expect(document.querySelector(".sl-toast__text")?.textContent).toBe(
			COPY.toast.keybind(COPY.keybind.actions.playMove, "W")
		);
		// A free key is a plain write; scope → global needs a modifier and re-validates rows.
		click(q(speak, ".sl-keybind__key"));
		key(document, "keydown", { key: "p", code: "KeyP" });
		key(document, "keyup", { key: "p", code: "KeyP" });
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({
			keybinds: {
				speakMove: {
					key: "p",
					code: "KeyP",
					altKey: false,
					ctrlKey: false,
					metaKey: false,
					shiftKey: false,
				},
			},
		});
		click(q(row(h.root, "keybinds.global"), '.sl-segment__item[data-value="global"]'));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ keybinds: { global: true } });
		expect(play.querySelector<HTMLElement>(".sl-keybind")?.dataset.invalid).toBe("true");
		expect(q(play, ".sl-keybind__hint").textContent).toBe(COPY.keybind.global);
	});
});

describe("settings view · display", () => {
	it("populates the explicit-speech voice select independently of the legacy automatic TTS flag", async () => {
		const h = await mountSettings();
		const voice = row(h.root, "display.ttsVoice");
		const select = q<HTMLSelectElement>(voice, "select");
		expect(select.disabled).toBe(false);
		const labels = [...select.querySelectorAll("option")].map((o) => o.textContent);
		expect(labels).toEqual([
			SETTINGS_COPY.voice.default,
			"Sim English (en-US)",
			"Sim British (en-GB)",
		]);
		expect(select.value).toBe("");
		await dom.tick(0);
		expect(h.patches).toEqual([]);
		expect(select.disabled).toBe(false);
		select.value = "Sim British";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ display: { ttsVoice: "Sim British" } });
		// A stored voice is selected from the snapshot.
		h.store.emit(
			makeSnapshot({
				settings: { display: { ...DEFAULT_SETTINGS.display, tts: true, ttsVoice: "Sim English" } },
			})
		);
		await dom.tick(0);
		expect(select.value).toBe("Sim English");
		// Choosing the default writes null.
		select.value = "";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ display: { ttsVoice: null } });
	});
});

describe("settings view · account", () => {
	it("masks the license key, reveals it for 10 s, and signs out after a confirm", async () => {
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.licenseKey]: "SL-7F3K-AB12-CD34" });
		const snapshot = makeSnapshot();
		snapshot.license = { status: "valid", checkedAt: 1, expiresAt: Date.UTC(2026, 7, 12) };
		const h = await mountSettings(snapshot);
		await dom.tick(0);
		const keyEl = q(h.root, ".sl-settings-license__key");
		expect(keyEl.textContent).toBe("SL-7F3K-••••-••••");
		const eye = q(h.root, ".sl-settings-license__reveal");
		expect(eye.getAttribute("aria-label")).toBe(COPY.login.reveal);
		click(eye);
		expect(keyEl.textContent).toBe("SL-7F3K-AB12-CD34");
		expect(eye.getAttribute("aria-label")).toBe(COPY.login.hide);
		expect(UI_TIMINGS.licenseRevealMs).toBe(10_000);
		await dom.tick(UI_TIMINGS.licenseRevealMs - 1);
		expect(keyEl.textContent).toBe("SL-7F3K-AB12-CD34");
		await dom.tick(1);
		expect(keyEl.textContent).toBe("SL-7F3K-••••-••••");
		expect(eye.getAttribute("aria-label")).toBe(COPY.login.reveal);
		// Clicking again while revealed re-masks at once.
		click(eye);
		expect(keyEl.textContent).toBe("SL-7F3K-AB12-CD34");
		click(eye);
		expect(keyEl.textContent).toBe("SL-7F3K-••••-••••");
		// Plan and device rows.
		expect(q(h.root, '[data-row="plan"] .sl-settings-row__value').textContent).toBe(
			SETTINGS_COPY.account.plan("12 Aug 2026")
		);
		expect(q(h.root, '[data-row="device"] .sl-settings-row__value').textContent).not.toBe("");
		// Manage devices opens the website through the shell action; Sign out confirms first.
		const manage = q(h.root, ".sl-settings-account__manage");
		expect(manage.dataset.action).toBe("open-url");
		expect(manage.dataset.url).toBe("website");
		click(q(h.root, ".sl-settings-account__signout"));
		const confirm = q(document, ".sl-popover .sl-settings-confirm");
		expect(q(confirm, ".sl-settings-confirm__text").textContent).toBe(COPY.account.signOutConfirm);
		click(q(confirm, ".sl-settings-confirm__cancel"));
		await dom.tick(0);
		expect(h.store.dispatched).toEqual([]);
		click(q(h.root, ".sl-settings-account__signout"));
		click(q(document, ".sl-popover .sl-settings-confirm__confirm"));
		await dom.tick(0);
		expect(h.store.dispatched).toEqual([MSG.PANEL_LOGOUT]);
	});
});

describe("settings view · advanced and footer", () => {
	it("Reset all settings confirms, then writes DEFAULT_SETTINGS; export dispatches; footer shows version · build", async () => {
		const h = await mountSettings();
		const reset = q(h.root, ".sl-settings-advanced__reset");
		expect(reset.textContent?.trim()).toBe(SETTINGS_COPY.advanced.resetAll);
		click(reset);
		const confirm = q(document, ".sl-popover .sl-settings-confirm");
		expect(q(confirm, ".sl-settings-confirm__text").textContent).toBe(COPY.account.resetConfirm);
		expect(q(confirm, ".sl-settings-confirm__confirm").textContent?.trim()).toBe(COPY.account.reset);
		expect(q(confirm, ".sl-settings-confirm__cancel").textContent?.trim()).toBe(COPY.account.cancel);
		click(q(confirm, ".sl-settings-confirm__cancel"));
		await dom.tick(0);
		expect(h.patches).toEqual([]);
		expect(document.querySelector(".sl-popover")).toBeNull();
		click(reset);
		click(q(document, ".sl-popover .sl-settings-confirm__confirm"));
		await dom.tick(0);
		expect(h.patches).toEqual([DEFAULT_SETTINGS]);
		expect(document.querySelector(".sl-popover")).toBeNull();
		click(q(h.root, ".sl-settings-advanced__export"));
		await dom.tick(0);
		expect(h.store.dispatched).toEqual([MSG.PANEL_EXPORT_TIMING_LOG]);
		// Hash is a select over the power-of-two sizes inside LIMITS; depth cap a slider.
		const hash = q<HTMLSelectElement>(row(h.root, "engine.hashMb"), "select");
		expect([...hash.querySelectorAll("option")].map((o) => o.value)).toEqual([
			"16",
			"32",
			"64",
			"128",
		]);
		expect(hash.value).toBe(String(DEFAULT_SETTINGS.engine.hashMb));
		const depth = q(row(h.root, "engine.depthCap"), "[role=slider]");
		expect(depth.getAttribute("aria-valuemin")).toBe(String(LIMITS.depthMin));
		expect(depth.getAttribute("aria-valuemax")).toBe(String(LIMITS.depthMax));
		expect(q(h.root, ".sl-settings__footer-version").textContent).toBe(COPY.footer("test", "test"));
		expect(q(h.root, ".sl-settings__footer-version").textContent).toBe("sliced vtest · build test");
		// Task 34: third-party notices next to the version (strings only in copy.ts).
		expect(q(h.root, '.sl-settings__footer-notice[data-notice="engine"]').textContent).toBe(
			COPY.notices.engine
		);
		expect(q(h.root, '.sl-settings__footer-notice[data-notice="timing"]').textContent).toBe(
			COPY.notices.timing
		);
		expect(COPY.notices.timing).toContain("PolyForm Noncommercial 1.0.0");
	});
});

describe("settings search and save feedback", () => {
	it("filters matching rows and sections, explains an empty result, and restores every row", async () => {
		const h = await mountSettings();
		const search = q<HTMLInputElement>(h.root, ".sl-settings__search");
		search.value = "premove";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(row(h.root, "timing.premoveTendency").hidden).toBe(false);
		expect(row(h.root, "strength.targetElo").hidden).toBe(true);
		expect(q<HTMLElement>(h.root, '[data-section="strength"]').hidden).toBe(true);
		expect(q<HTMLElement>(h.root, ".sl-settings__jump").hidden).toBe(true);
		search.value = "Timing";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(row(h.root, "timing.respectBudget").hidden).toBe(false);
		expect(row(h.root, "timing.speedScale").hidden).toBe(false);
		search.value = "no setting could match this";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(q<HTMLElement>(h.root, ".sl-settings__empty").hidden).toBe(false);
		search.value = "";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(q<HTMLElement>(h.root, ".sl-settings__empty").hidden).toBe(true);
		for (const el of h.root.querySelectorAll<HTMLElement>(".sl-settings-row, .sl-settings__section"))
			expect(el.hidden).toBe(false);
	});

	it("shows failed saves and restores the persisted switch value", async () => {
		const h = await mountSettings(makeSnapshot(), {
			view: createSettingsView({
				setSettings: async () => {
					throw new Error("storage unavailable");
				},
			}),
		});
		const toggle = q(row(h.root, "strength.useOpeningBook"), "[role=switch]");
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		click(toggle);
		expect(q(h.root, ".sl-settings__save").textContent).toBe(COPY.workspace.saving);
		await dom.tick(0);
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(q(h.root, ".sl-settings__save").textContent).toBe(COPY.workspace.saveFailed);
		expect(q(h.root, ".sl-settings__save").getAttribute("role")).toBe("status");
	});
});

it("keeps the save indicator pending until the final queued write finishes", async () => {
	const finishes: Array<(settings: Settings) => void> = [];
	const h = await mountSettings(makeSnapshot(), {
		view: createSettingsView({
			setSettings: () =>
				new Promise<Settings>((resolve) => {
					finishes.push(resolve);
				}),
		}),
	});
	click(q(row(h.root, "strength.useOpeningBook"), "[role=switch]"));
	click(q(row(h.root, "automation.autoQueue"), "[role=switch]"));
	await dom.tick(0);
	expect(finishes).toHaveLength(1);
	finishes[0]?.(normalizeSettings(DEFAULT_SETTINGS));
	await dom.tick(0);
	expect(finishes).toHaveLength(2);
	expect(q(h.root, ".sl-settings__save").textContent).toBe(COPY.workspace.saving);
	finishes[1]?.(normalizeSettings(DEFAULT_SETTINGS));
	await dom.tick(0);
	expect(q(h.root, ".sl-settings__save").textContent).toBe(COPY.workspace.saved);
});
