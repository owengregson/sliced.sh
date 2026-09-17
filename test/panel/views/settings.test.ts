// test/panel/views/settings.test.ts — Task 25: the Settings view (Appendix F §4.6 / §7.2).
// Every `Settings` leaf has a row (except the forced leaves in `FORCED_SETTINGS`, which have
// none); live controls remain available; a row change writes the
// clamped value through `setSettings`; category chips intersect with the text search;
// strength labels per band and the ≥ 3000 warning; timing presets pre-select the detected time
// control; keybind rows swap on conflict; the TTS voice select follows `display.tts`; the license
// reveal re-masks after 10 s; reset confirms; the footer shows version and build.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_KEYBINDS,
	DEFAULT_SETTINGS,
	FORCED_SETTING_VALUES,
	LIMITS,
	LOCAL_KEYS,
	MAIA,
	MSG,
	type PanelSnapshot,
	STRENGTH_LABEL_BANDS,
	UI_TIMINGS,
} from "@core/constants";
import { normalizeSettings, type SettingsPatch } from "@core/storage/settings-storage";
import { COPY, KEYBIND_SCOPE_FORCED, RESPECT_BUDGET_FORCED, SETTINGS_COPY } from "@panel/copy";
import type { PanelStore } from "@panel/store";
import type { PanelUiState, Router, View, ViewContext } from "@panel/view";
import { VIEWS } from "@panel/views";
import { createSettingsView } from "@panel/views/settings";
import {
	clampRowValue,
	getAtPath,
	ROWS,
	type SettingsLeafPath,
	strengthBand,
	strengthLabel,
} from "@panel/views/settings/rows";
import {
	FORCED_SETTINGS,
	isSectionId,
	MANAGED_SETTINGS,
	SECTIONS,
} from "@panel/views/settings/sections";
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

function fixedRating(snapshot: PanelSnapshot = makeSnapshot()): PanelSnapshot {
	snapshot.settings = normalizeSettings(snapshot.settings);
	snapshot.settings.strength.matchOpponentRating = false;
	return snapshot;
}

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
		// The forced leaves (owner, 2026-09-12) are exactly the leaves of `FORCED_SETTING_VALUES`,
		// each forced to its shipped default, and none of them is rendered.
		const forced = Object.keys(FORCED_SETTINGS).sort();
		expect(forced).toEqual(leafPaths(FORCED_SETTING_VALUES).sort());
		expect(forced.length).toBe(8);
		expect(FORCED_SETTINGS["timing.respectBudget"]).toBe(RESPECT_BUDGET_FORCED);
		expect(FORCED_SETTINGS["keybinds.global"]).toBe(KEYBIND_SCOPE_FORCED);
		for (const path of forced as SettingsLeafPath[]) {
			expect(getAtPath(FORCED_SETTING_VALUES as Settings, path), `forced ${path}`).toEqual(
				getAtPath(DEFAULT_SETTINGS, path)
			);
			expect(h.root.querySelector(`[data-path="${path}"]`), `no row for ${path}`).toBeNull();
			expect(FORCED_SETTINGS[path as keyof typeof FORCED_SETTINGS].length).toBeGreaterThan(0);
		}
		// Legacy automatic speech is retained in storage, but deliberately has no UI control.
		const paths = leafPaths(DEFAULT_SETTINGS).filter(
			(path) => !(path in MANAGED_SETTINGS) && !forced.includes(path)
		);
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
		// Settings layout, 2026-09-13 (`docs/qa/settings-layout-2026-09-13.md`): the ten sections,
		// Strength first with the target rating as its first row, the master switch first in
		// Automation, dependants directly beneath their switch, paired ranges adjacent.
		expect(SECTIONS.map((s) => s.id)).toEqual([
			"strength",
			"automation",
			"timing",
			"board",
			"panel",
			"keybinds",
			"engine",
			"account",
			"advanced",
		]);
		const rowsOf = (id: string): readonly string[] => SECTIONS.find((s) => s.id === id)?.rows ?? [];
		expect(rowsOf("strength")).toEqual([
			"strength.targetElo",
			"strength.matchOpponentRating",
			"strength.personaEloOffset",
			"strength.useOpeningBook",
		]);
		expect(rowsOf("automation")).toEqual([
			"enabled",
			"automation.resignLostGames",
			"automation.autoQueue",
			"automation.autoQueueSessionMinMinutes",
			"automation.autoQueueSessionMaxMinutes",
			"automation.autoQueueBreakMinMinutes",
			"automation.autoQueueBreakMaxMinutes",
			"automation.rematchTitled",
		]);
		// 2026-09-15: the `timing.profile` preset row that used to head this section was removed.
		expect(rowsOf("timing")).toEqual([
			"timing.baseSpeed",
			"timing.varianceScale",
			"timing.longThinkFrequency",
			"timing.premoveTendency",

			"execution.inputMode",
			"execution.motorSpeed",
			"execution.previewSelectScale",
			"execution.verifyMoves",
			"display.virtualCursor",
			"display.cursorEffects",
		]);
		expect(rowsOf("board")).toEqual([
			"automation.highlightMoves",
			"automation.highlightStyle",
			"automation.boardEffects",
			"automation.moveQualityChips",
			"automation.moveQualityChipsFor",
			"automation.moveRatingSounds",
			"automation.forcedMateSounds",
			"automation.freeTitle",
			"automation.freeTitleBadge",
		]);
		expect(rowsOf("panel")).toEqual([
			"display.evalBar",
			"engine.multiPv",
			"display.theme",
			"display.reducedMotion",
			"display.uiSounds",
			"display.ttsVoice",
		]);
		expect(rowsOf("engine")).toEqual(["engine.threads", "engine.hashMb", "engine.depthCap"]);
		expect(rowsOf("advanced")).toEqual(["advanced.logLevel", "advanced.timingLogEnabled"]);
		for (const section of SECTIONS) {
			const el = h.root.querySelector(`[data-section="${section.id}"]`);
			expect(el?.querySelector(".sl-section__title")?.textContent).toBe(section.title);
		}
		// The DOM follows the table: the target rating is the first row on the page.
		expect(h.root.querySelector<HTMLElement>(".sl-settings-row[data-path]")?.dataset.path).toBe(
			"strength.targetElo"
		);
		// V2.1 additions and their copy.
		expect(row(h.root, "strength.matchOpponentRating").querySelector("[role=switch]")).not.toBeNull();
		expect(row(h.root, "strength.personaEloOffset").querySelector("[role=slider]")).not.toBeNull();
		// The preview segment folded into the rate slider (one control with an Off position).
		expect(h.root.querySelector('[data-path="execution.previewSelects"]')).toBeNull();
		expect(row(h.root, "execution.previewSelectScale").querySelector("[role=slider]")).not.toBeNull();
		expect(row(h.root, "automation.resignLostGames").querySelector("[role=switch]")).not.toBeNull();
		expect(row(h.root, "automation.moveQualityChips").querySelector("[role=switch]")).not.toBeNull();
		expect(h.root.querySelector('[data-path="display.pvCount"]')).toBeNull();
		expect(h.root.querySelector('[data-path="keybinds.global"]')).toBeNull();
		expect(h.root.querySelector('[data-path="timing.respectBudget"]')).toBeNull();
		const highlight = row(h.root, "automation.highlightMoves");
		expect(highlight.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe(
			String(DEFAULT_SETTINGS.automation.highlightMoves)
		);
		expect(highlight.querySelector(".sl-settings-row__help")?.textContent).toBe(
			SETTINGS_COPY.rows["automation.highlightMoves"].help
		);
		// Board effects (owner's brief, 2026-09-13): a toggle directly beneath "Highlight moves".
		const boardEffects = row(h.root, "automation.boardEffects");
		expect(boardEffects.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe(
			String(DEFAULT_SETTINGS.automation.boardEffects)
		);
		expect(boardEffects.querySelector(".sl-settings-row__help")?.textContent).toBe(
			SETTINGS_COPY.rows["automation.boardEffects"].help
		);
		expect(
			highlight.compareDocumentPosition(boardEffects) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeGreaterThan(0);
		expect(
			row(h.root, "execution.verifyMoves").querySelector(".sl-settings-row__help")?.textContent
		).toBe(COPY.execution.verify);
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
		const h = await mountSettings(fixedRating());
		// Toggle → boolean patch.
		click(q(row(h.root, "strength.useOpeningBook"), "[role=switch]"));
		await dom.tick(0);
		expect(h.patches).toEqual([{ strength: { useOpeningBook: false } }]);
		// Slider: End goes to the table max, which is the LIMITS clamp.
		key(q(row(h.root, "strength.targetElo"), "[role=slider]"), "keydown", { key: "End" });
		await dom.tick(0);
		expect(h.patches[1]).toEqual({ strength: { targetElo: LIMITS.eloMax } });
		// Stepper: + at the max is a no-op write-wise; − steps down by one.
		const pv = row(h.root, "engine.multiPv");
		for (let i = 0; i < LIMITS.multiPvMax + 2; i++) click(q(pv, ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.settings().engine.multiPv).toBe(LIMITS.multiPvMax);
		expect(q(pv, ".sl-stepper__value").textContent).toBe(String(LIMITS.multiPvMax));
		click(q(pv, ".sl-stepper__button--dec"));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ engine: { multiPv: LIMITS.multiPvMax - 1 } });
		// Chips and segments → enum patches.
		click(q(row(h.root, "automation.highlightStyle"), '.sl-chip[data-value="arrows"]'));
		click(q(row(h.root, "execution.inputMode"), 'input[value="click"]'));
		await dom.tick(0);
		expect(h.patches.at(-2)).toEqual({ automation: { highlightStyle: "arrows" } });
		expect(h.patches.at(-1)).toEqual({ execution: { inputMode: "click" } });
		// The preview slider's Home is its Off position (0), labelled as such.
		const preview = row(h.root, "execution.previewSelectScale");
		expect(q(preview, ".sl-slider__value").textContent).toBe(
			SETTINGS_COPY.format.times(DEFAULT_SETTINGS.execution.previewSelectScale)
		);
		key(q(preview, "[role=slider]"), "keydown", { key: "Home" });
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ execution: { previewSelectScale: 0 } });
		expect(q(preview, ".sl-slider__value").textContent).toBe(SETTINGS_COPY.format.previewOff);
		expect(q(preview, "[role=slider]").getAttribute("aria-valuetext")).toBe(
			SETTINGS_COPY.format.previewOff
		);
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
		expect(clampRowValue("engine.multiPv", 3.4)).toBe(3);
		// A snapshot from the SW re-renders the controls.
		h.store.emit(
			makeSnapshot({
				settings: {
					display: { ...DEFAULT_SETTINGS.display, evalBar: false },
					engine: { ...DEFAULT_SETTINGS.engine, multiPv: 2 },
				},
			})
		);
		await dom.tick(0);
		expect(q(row(h.root, "engine.multiPv"), ".sl-stepper__value").textContent).toBe("2");
		expect(q(row(h.root, "display.evalBar"), "[role=switch]").getAttribute("aria-checked")).toBe(
			"false"
		);
	});
});

describe("settings view · playing sessions", () => {
	it.each([
		["automation.autoQueueSessionMinMinutes", 20],
		["automation.autoQueueSessionMaxMinutes", 60],
		["automation.autoQueueBreakMinMinutes", 5],
		["automation.autoQueueBreakMaxMinutes", 20],
	] as const)(
		"enables %s with auto-queue and retains its value when disabled",
		async (path, initial) => {
			const h = await mountSettings();
			const queue = q(row(h.root, "automation.autoQueue"), "[role=switch]");
			const target = row(h.root, path);
			const stepper = q(target, ".sl-stepper");
			const increment = q(target, ".sl-stepper__button--inc");
			expect(stepper.getAttribute("aria-disabled")).toBe("true");
			expect(q(target, ".sl-stepper__value").textContent).toBe(`${initial} min`);
			click(increment);
			await dom.tick(0);
			expect(h.patches).toEqual([]);
			click(queue);
			await dom.tick(0);
			expect(stepper.getAttribute("aria-disabled")).toBeNull();
			click(increment);
			await dom.tick(0);
			expect(q(target, ".sl-stepper__value").textContent).toBe(`${initial + 1} min`);
			click(queue);
			await dom.tick(0);
			expect(stepper.getAttribute("aria-disabled")).toBe("true");
			click(queue);
			await dom.tick(0);
			expect(q(target, ".sl-stepper__value").textContent).toBe(`${initial + 1} min`);
		}
	);

	it("keeps a range ordered when one endpoint crosses the other", async () => {
		const automation = {
			...DEFAULT_SETTINGS.automation,
			autoQueue: true,
			autoQueueSessionMinMinutes: 30,
			autoQueueSessionMaxMinutes: 30,
			autoQueueBreakMinMinutes: 10,
			autoQueueBreakMaxMinutes: 10,
		};
		const h = await mountSettings(makeSnapshot({ settings: { automation } }));
		click(q(row(h.root, "automation.autoQueueSessionMinMinutes"), ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({
			automation: { autoQueueSessionMinMinutes: 31, autoQueueSessionMaxMinutes: 31 },
		});
		click(q(row(h.root, "automation.autoQueueBreakMaxMinutes"), ".sl-stepper__button--dec"));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({
			automation: { autoQueueBreakMinMinutes: 9, autoQueueBreakMaxMinutes: 9 },
		});
	});

	it("bounds session settings and follows external dependency changes", async () => {
		const automation = {
			...DEFAULT_SETTINGS.automation,
			autoQueue: true,
			autoQueueSessionMaxMinutes: LIMITS.autoQueueSessionMinutesMax,
		};
		const h = await mountSettings(makeSnapshot({ settings: { automation } }));
		const maxRow = row(h.root, "automation.autoQueueSessionMaxMinutes");
		expect(q(maxRow, ".sl-stepper__button--inc").getAttribute("aria-disabled")).toBe("true");
		click(q(maxRow, ".sl-stepper__button--inc"));
		await dom.tick(0);
		expect(h.patches).toEqual([]);
		h.store.emit(makeSnapshot({ settings: { automation: { ...automation, autoQueue: false } } }));
		expect(q(maxRow, ".sl-stepper").getAttribute("aria-disabled")).toBe("true");
		expect(clampRowValue("automation.autoQueueSessionMinMinutes", 0)).toBe(1);
		expect(clampRowValue("automation.autoQueueSessionMaxMinutes", 999)).toBe(240);
		expect(clampRowValue("automation.autoQueueBreakMaxMinutes", 999)).toBe(180);
	});
});

describe("settings view · live interaction", () => {
	it("derives read-only depth from live matched Elo and updates when strength changes", async () => {
		const snapshot = makeSnapshot({
			state: "live:opponent-turn",
			settings: {
				strength: { ...DEFAULT_SETTINGS.strength, targetElo: 3800, matchOpponentRating: true },
				engine: { ...DEFAULT_SETTINGS.engine, depthCap: 6 },
			},
		});
		snapshot.opponent = {
			isBot: false,
			name: "opponent",
			ratingEstimate: 1600,
			derivedTargetElo: 1650,
		};
		const h = await mountSettings(snapshot);
		const depth = row(h.root, "engine.depthCap");
		const output = q(depth, ".sl-settings-row__value");
		// 17, not 16: the automatic depth curve now ends at the Maia cutoff (owner, 2026-09-15).
		expect(output.textContent).toBe("Auto · 17");
		expect(depth.querySelector("button, input, [role=slider]")).toBeNull();
		key(output, "keydown", { key: "End" });
		expect(h.patches).toHaveLength(0);
		h.store.emit({
			...snapshot,
			opponent: { ...snapshot.opponent, derivedTargetElo: 3250 },
		});
		expect(output.textContent).toBe("Auto · 30");
		h.store.emit(snapshot);
		expect(output.textContent).toBe("Auto · 17");
		click(q(row(h.root, "strength.matchOpponentRating"), "[role=switch]"));
		await dom.tick(0);
		expect(output.textContent).toBe("Auto · 30");
		key(q(row(h.root, "strength.targetElo"), "[role=slider]"), "keydown", { key: "Home" });
		await dom.tick(0);
		expect(output.textContent).toBe("Auto · 6");
		expect(h.patches.every((patch) => patch.engine === undefined)).toBe(true);
	});

	it("disables and dims the fixed target while matching the opponent, retaining its saved value", async () => {
		const h = await mountSettings();
		const target = row(h.root, "strength.targetElo");
		const thumb = q(target, "[role=slider]");
		expect(h.root.classList.contains("sl-settings--matched-rating")).toBe(true);
		expect(thumb.getAttribute("aria-disabled")).toBe("true");
		expect(q<HTMLElement>(target, ".sl-settings-row__help").hidden).toBe(true);
		key(thumb, "keydown", { key: "End" });
		expect(h.patches).toHaveLength(0);
		click(q(row(h.root, "strength.matchOpponentRating"), "[role=switch]"));
		await dom.tick(0);
		expect(thumb.getAttribute("aria-disabled")).toBeNull();
		expect(h.root.classList.contains("sl-settings--matched-rating")).toBe(false);
		key(thumb, "keydown", { key: "End" });
		await dom.tick(0);
		expect(h.settings().strength.targetElo).toBe(LIMITS.eloMax);
		click(q(row(h.root, "strength.matchOpponentRating"), "[role=switch]"));
		await dom.tick(0);
		expect(thumb.getAttribute("aria-disabled")).toBe("true");
		expect(h.settings().strength.targetElo).toBe(LIMITS.eloMax);
	});
	it("in persona-offset mode the target slider follows the Elo actually being played and stays display-only (owner, 2026-09-15)", async () => {
		const matched = (opponent?: NonNullable<PanelSnapshot["opponent"]>): PanelSnapshot => {
			const snapshot = makeSnapshot({
				state: "live:opponent-turn",
				settings: {
					strength: {
						...DEFAULT_SETTINGS.strength,
						targetElo: 1200,
						matchOpponentRating: true,
						personaEloOffset: 40,
					},
				},
			});
			if (opponent) snapshot.opponent = opponent;
			return snapshot;
		};
		const opponent = (ratingEstimate: number, derivedTargetElo: number) => ({
			isBot: false,
			name: "opponent",
			ratingEstimate,
			derivedTargetElo,
		});
		const h = await mountSettings(matched(opponent(1497, 1537)));
		const target = row(h.root, "strength.targetElo");
		const thumb = q(target, "[role=slider]");
		// The session's derived target (rating 1497 + offset 40), exactly — not snapped to 1550.
		expect(thumb.getAttribute("aria-valuenow")).toBe("1537");
		expect(q(target, ".sl-slider__value").textContent).toBe("1537");
		expect(thumb.getAttribute("aria-valuetext")).toBe(strengthLabel(1537));
		expect(q(target, ".sl-slider__caption").textContent).toBe(COPY.strength.bands.advanced);
		expect(thumb.getAttribute("aria-disabled")).toBe("true");
		// A new rating (or offset) arrives with the next snapshot: the slider follows it live.
		h.store.emit(matched(opponent(2210, 2250)));
		expect(thumb.getAttribute("aria-valuenow")).toBe("2250");
		expect(q(target, ".sl-slider__caption").textContent).toBe(COPY.strength.bands.master);
		// No rating known yet: the session plays the stored target meanwhile, so that is what shows.
		h.store.emit(matched());
		expect(thumb.getAttribute("aria-valuenow")).toBe("1200");
		// Display only: a key does nothing and nothing is written from the reading.
		h.store.emit(matched(opponent(2210, 2250)));
		key(thumb, "keydown", { key: "End" });
		await dom.tick(0);
		expect(h.patches).toHaveLength(0);
		expect(thumb.getAttribute("aria-valuenow")).toBe("2250");
		// Matching off: the stored target again, and the slider is the user's to move.
		click(q(row(h.root, "strength.matchOpponentRating"), "[role=switch]"));
		await dom.tick(0);
		expect(h.patches).toEqual([{ strength: { matchOpponentRating: false } }]);
		expect(thumb.getAttribute("aria-disabled")).toBeNull();
		expect(thumb.getAttribute("aria-valuenow")).toBe("1200");
		expect(h.settings().strength.targetElo).toBe(1200);
	});

	it("keeps live settings writable through game transitions", async () => {
		const h = await mountSettings(fixedRating(makeSnapshot({ state: "live:opponent-turn" })));
		expect(h.root.getAttribute("aria-disabled")).toBeNull();
		expect(h.root.classList.contains("sl-settings--locked")).toBe(false);
		const book = q(row(h.root, "strength.useOpeningBook"), "[role=switch]");
		expect(book.getAttribute("aria-disabled")).toBeNull();
		click(book);
		await dom.tick(0);
		expect(h.patches).toEqual([{ strength: { useOpeningBook: false } }]);
		for (const state of ["game-over", "live:my-turn:analysing"] as const) {
			h.store.emit(fixedRating(makeSnapshot({ state })));
			await dom.tick(0);
			expect(h.root.getAttribute("aria-disabled")).toBeNull();
			expect(
				q(row(h.root, "strength.targetElo"), "[role=slider]").getAttribute("aria-disabled")
			).toBeNull();
		}
		key(q(row(h.root, "strength.targetElo"), "[role=slider]"), "keydown", { key: "End" });
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ strength: { targetElo: LIMITS.eloMax } });
	});

	it("keeps deliberate reset and sign-out confirmations available when a game starts", async () => {
		const h = await mountSettings();
		click(q(h.root, ".sl-settings-advanced__reset"));
		h.store.emit(makeSnapshot({ state: "live:opponent-turn" }));
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).not.toBeNull();
		click(q(document, ".sl-popover .sl-settings-confirm__confirm"));
		await dom.tick(0);
		expect(h.patches).toHaveLength(1);
		expect(h.patches[0]).toEqual(DEFAULT_SETTINGS);
		click(q(h.root, ".sl-settings-account__signout"));
		expect(document.querySelector(".sl-popover")).not.toBeNull();
		click(q(document, ".sl-popover .sl-settings-confirm__confirm"));
		await dom.tick(0);
		expect(h.store.dispatched).toContain(MSG.PANEL_LOGOUT);
	});
});

describe("settings view · category filters", () => {
	it("defaults to All and filters sections without scrolling", async () => {
		const h = await mountSettings();
		const chips = q(h.root, ".sl-settings__jump .sl-chip-group");
		expect(chips.querySelectorAll(".sl-chip")).toHaveLength(SECTIONS.length + 1);
		expect(q(chips, '.sl-chip[data-value="all"]').getAttribute("aria-pressed")).toBe("true");
		const sections = [...h.root.querySelectorAll<HTMLElement>("[data-section]")];
		expect(sections.filter((section) => !section.hidden)).toHaveLength(SECTIONS.length);
		const scrolled: string[] = [];
		for (const section of sections)
			section.scrollIntoView = () => void scrolled.push(section.dataset.section ?? "");
		click(q(chips, '.sl-chip[data-value="account"]'));
		expect(
			sections.filter((section) => !section.hidden).map((section) => section.dataset.section)
		).toEqual(["account"]);
		expect(scrolled).toEqual([]);
		click(q(chips, '.sl-chip[data-value="all"]'));
		expect(sections.filter((section) => !section.hidden)).toHaveLength(SECTIONS.length);
	});

	it("intersects search with the selected category and restores matching sections on All", async () => {
		const h = await mountSettings();
		const chips = q(h.root, ".sl-settings__jump .sl-chip-group");
		const search = q(h.root, ".sl-settings__search") as HTMLInputElement;
		click(q(chips, '.sl-chip[data-value="timing"]'));
		search.value = "opening book";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		const visible = () =>
			[...h.root.querySelectorAll<HTMLElement>("[data-section]")]
				.filter((section) => !section.hidden)
				.map((section) => section.dataset.section);
		expect(visible()).toEqual([]);
		click(q(chips, '.sl-chip[data-value="all"]'));
		expect(visible()).toEqual(["strength"]);
		search.value = "";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(visible()).toHaveLength(SECTIONS.length);
	});
});

describe("settings view · strength", () => {
	// Owner, 2026-09-15: seven categories (there were five — Expert from 1400, Master from 2000,
	// Elite from 2600 up), the current one captioned under the slider instead of a row naming every
	// category, and a single divider at the Maia cutoff (it was the 3200 network switch, beside a
	// second unlabelled Maia marker).
	it("labels the slider by band, captions only the current band, draws one divider and warns from 3000", async () => {
		expect(STRENGTH_LABEL_BANDS.map((b) => [b.min, b.band])).toEqual([
			[400, "casual"],
			[800, "club"],
			[1400, "advanced"],
			[1800, "expert"],
			[2200, "master"],
			[2600, "elite"],
			[3000, "championI"],
			[3400, "championII"],
		]);
		for (const [elo, band] of [
			[400, "casual"],
			[799, "casual"],
			[800, "club"],
			[1399, "club"],
			[1400, "advanced"],
			[1799, "advanced"],
			[1800, "expert"],
			[2199, "expert"],
			[2200, "master"],
			[2599, "master"],
			[2600, "elite"],
			[2999, "elite"],
			[3000, "championI"],
			[3399, "championI"],
			[3400, "championII"],
			[LIMITS.eloMax, "championII"],
		] as const)
			expect(strengthBand(elo)).toBe(band);
		expect(strengthLabel(1200)).toBe("Club 1200");
		expect(strengthLabel(1500)).toBe("Advanced 1500");
		expect(strengthLabel(2650)).toBe("Elite 2650");
		// Owner, 2026-09-15: Champion is two bands, split at 3400.
		expect(strengthLabel(3000)).toBe("Champion I 3000");
		expect(strengthLabel(3400)).toBe("Champion II 3400");

		const h = await mountSettings(fixedRating());
		const slider = row(h.root, "strength.targetElo");
		const thumb = q(slider, "[role=slider]");
		expect(thumb.getAttribute("aria-valuetext")).toBe("Advanced 1500");
		expect(thumb.getAttribute("aria-valuemax")).toBe(String(LIMITS.eloMax));
		expect(q(slider, ".sl-slider__divider").dataset.value).toBe(String(MAIA.eloMax));
		expect(q(slider, ".sl-slider__divider").style.left).toBe(
			`${(((MAIA.eloMax - LIMITS.eloMin) / (LIMITS.eloMax - LIMITS.eloMin)) * 100).toFixed(3)}%`
		);
		expect(slider.querySelectorAll(".sl-slider__marker")).toHaveLength(0);
		expect(q<HTMLElement>(slider, ".sl-slider__boundary").hidden).toBe(true);
		expect(q(slider, ".sl-slider__boundary").textContent?.trim()).toBe("");
		expect(q(slider, ".sl-slider__bubble").textContent).toBe("Advanced 1500");
		// No row of every category: one caption naming the current one, silent to assistive tech
		// (the thumb's `aria-valuetext` already says it).
		expect(slider.querySelectorAll(".sl-slider__mark, .sl-slider__scale")).toHaveLength(0);
		const caption = q<HTMLElement>(slider, ".sl-slider__caption");
		expect(caption.hidden).toBe(false);
		expect(caption.getAttribute("aria-hidden")).toBe("true");
		expect(caption.textContent).toBe(COPY.strength.bands.advanced);
		expect(q(slider, ".sl-slider__hint").hidden).toBe(true);
		key(thumb, "keydown", { key: "PageUp" });
		expect(thumb.getAttribute("aria-valuenow")).toBe("2000");
		expect(caption.textContent).toBe(COPY.strength.bands.expert);
		key(thumb, "keydown", { key: "End" });
		expect(caption.textContent).toBe(COPY.strength.bands.championII);
		expect(thumb.getAttribute("aria-valuetext")).toBe(`Champion II ${LIMITS.eloMax}`);
		expect(q(slider, ".sl-slider").classList.contains("sl-slider--danger")).toBe(true);
		expect(q(slider, ".sl-slider__hint").hidden).toBe(false);
		expect(q(slider, ".sl-slider__hint").textContent).toBe(COPY.strength.warning);
		key(thumb, "keydown", { key: "Home" });
		expect(q(slider, ".sl-slider__hint").hidden).toBe(true);
		expect(caption.textContent).toBe(COPY.strength.bands.casual);
		// Owner, 2026-09-15: the high-strength indicator starts at the one strength division, 3000
		// (was 2600).
		expect(UI_TIMINGS.strengthDangerElo).toBe(3000);
		// An external change (another view, the service worker's normalisation) moves the caption too.
		const external = fixedRating();
		external.settings.strength.targetElo = 2650;
		h.store.emit(external);
		expect(caption.textContent).toBe(COPY.strength.bands.elite);
	});
});

// 2026-09-15: "settings view · timing presets" — the panel's own `tcClass` mapping and the preset
// chips' detected pre-selection, per-option description and "Detected: … / Overrides detection"
// note — was deleted with the feature at the owner's request. Nothing in the panel reads the time
// control any more, and chips are a plain stored-value control (covered by the theme, highlight
// style and log-level rows).

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
		// The scope row is gone (2026-09-13): page shortcuts never need a modifier.
		expect(h.root.querySelector('[data-path="keybinds.global"]')).toBeNull();
		expect(play.querySelector<HTMLElement>(".sl-keybind")?.dataset.invalid).toBeUndefined();
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
		// Hash remains editable; depth is derived automatically from active strength.
		const hash = q<HTMLSelectElement>(row(h.root, "engine.hashMb"), "select");
		expect([...hash.querySelectorAll("option")].map((o) => o.value)).toEqual([
			"16",
			"32",
			"64",
			"128",
		]);
		expect(hash.value).toBe(String(DEFAULT_SETTINGS.engine.hashMb));
		const depth = row(h.root, "engine.depthCap");
		expect(depth.querySelector("[role=slider]")).toBeNull();
		expect(q(depth, ".sl-settings-row__value").textContent).toContain("Auto · ");
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
		expect(q<HTMLElement>(h.root, ".sl-settings__jump").hidden).toBe(false);
		search.value = "Timing";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(row(h.root, "timing.varianceScale").hidden).toBe(false);
		expect(row(h.root, "timing.baseSpeed").hidden).toBe(false);
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

describe("settings outcomes and managed controls", () => {
	it("leaves auto-play in Game and removes the competing accuracy offset", async () => {
		const h = await mountSettings();
		expect(h.root.querySelector('[data-path="automation.autoMove"]')).toBeNull();
		expect(h.root.querySelector('[data-path="strength.blunderScale"]')).toBeNull();
		const go = q(h.root, '.sl-settings-autoplay [data-action="view-switch"]');
		expect(go.dataset.tab).toBe("game");
		expect(go.textContent).toContain(SETTINGS_COPY.autoplay.action);
		expect(h.patches).toEqual([]);
	});

	it("writes a named pace and retains exact fine-tuning without rounding to a choice", async () => {
		const snapshot = makeSnapshot();
		snapshot.settings = normalizeSettings({ timing: { baseSpeed: 1.15 } });
		const h = await mountSettings(snapshot);
		const pace = row(h.root, "timing.baseSpeed");
		expect(pace.querySelectorAll("input:checked")).toHaveLength(0);
		expect(q(pace, "summary").textContent).toBe("Custom · 1.15×");
		expect(h.patches).toEqual([]);
		click(q(pace, 'input[value="1.35"]'));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ timing: { baseSpeed: 1.35 } });
		expect(q(pace, "[role=slider]").getAttribute("aria-valuenow")).toBe("1.35");
		expect(q<HTMLInputElement>(pace, 'input[value="1.35"]').checked).toBe(true);
		key(q(pace, "[role=slider]"), "keydown", { key: "ArrowRight" });
		await dom.tick(0);
		expect(h.settings().timing.baseSpeed).toBe(1.4);
		expect(pace.querySelectorAll("input:checked")).toHaveLength(0);
		expect(q(pace, "summary").textContent).toBe("Custom · 1.40×");
	});

	it("restores a choice after a failed save and keeps every radio named", async () => {
		const h = await mountSettings(makeSnapshot(), {
			view: createSettingsView({
				setSettings: async () => {
					throw new Error("storage unavailable");
				},
			}),
		});
		const input = row(h.root, "execution.inputMode");
		click(q(input, 'input[value="click"]'));
		await dom.tick(0);
		expect(q<HTMLInputElement>(input, 'input[value="auto"]').checked).toBe(true);
		expect(q<HTMLInputElement>(input, 'input[value="click"]').checked).toBe(false);
		expect(q(h.root, ".sl-settings__save").textContent).toBe(COPY.workspace.saveFailed);
		for (const radio of h.root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
			expect(radio.closest("label")?.textContent?.trim().length).toBeGreaterThan(0);
			expect(radio.closest("fieldset")?.querySelector("legend")?.textContent?.length).toBeGreaterThan(
				0
			);
		}
	});
});

// ── settings layout, 2026-09-13: dependants beneath their switch, and disabled while it is off ──
describe("settings view · dependants", () => {
	// Owner, 2026-09-15: board effects and move ratings are independent, so the second half of this
	// test — which used to pin rating sounds greyed while board effects were off — now asserts the
	// opposite: the sounds follow move ratings alone.
	it("keeps rating sounds off while move ratings are off, and live while only board effects are", async () => {
		const h = await mountSettings();
		const ratings = q(row(h.root, "automation.moveQualityChips"), "[role=switch]");
		const sounds = q(row(h.root, "automation.moveRatingSounds"), "[role=switch]");
		click(ratings);
		await dom.tick(0);
		expect(sounds.getAttribute("aria-disabled")).toBe("true");
		click(sounds);
		await dom.tick(0);
		expect(h.settings().automation.moveRatingSounds).toBe(false);
		click(ratings);
		await dom.tick(0);
		click(q(row(h.root, "automation.boardEffects"), "[role=switch]"));
		await dom.tick(0);
		expect(h.settings().automation.boardEffects).toBe(false);
		expect(sounds.getAttribute("aria-disabled")).not.toBe("true");
		click(sounds);
		await dom.tick(0);
		expect(h.settings().automation.moveRatingSounds).toBe(true);
	});
	it("free title offers exactly five abbreviations beneath its opt-in switch", async () => {
		const h = await mountSettings();
		const toggleRow = row(h.root, "automation.freeTitle");
		const titleRow = row(h.root, "automation.freeTitleBadge");
		expect(toggleRow.nextElementSibling === titleRow).toBe(true);
		expect(titleRow.closest('[data-section="board"]')).not.toBeNull();
		const picker = q(titleRow, "[role=tablist]");
		expect(
			[...picker.querySelectorAll("[role=tab]")].map((node) => node.textContent?.trim())
		).toEqual(["GM", "IM", "NM", "FM", "CM"]);
		expect(picker.getAttribute("aria-disabled")).toBe("true");
		click(q(toggleRow, "[role=switch]"));
		await dom.tick(0);
		expect(picker.getAttribute("aria-disabled")).toBeNull();
		click(q(picker, '[data-value="FM"]'));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ automation: { freeTitleBadge: "FM" } });
		click(q(toggleRow, "[role=switch]"));
		await dom.tick(0);
		expect(picker.getAttribute("aria-disabled")).toBe("true");
		expect(h.settings().automation.freeTitleBadge).toBe("FM");
	});
	it("show ratings for: You / Opponent / Both beneath move ratings, Both by default, greyed while ratings are off", async () => {
		// Owner, 2026-09-15: a three-way picker directly below board ratings.
		const h = await mountSettings();
		const ratingsRow = row(h.root, "automation.moveQualityChips");
		const pickerRow = row(h.root, "automation.moveQualityChipsFor");
		expect(ratingsRow.nextElementSibling).toBe(pickerRow);
		expect(pickerRow.nextElementSibling).toBe(row(h.root, "automation.moveRatingSounds"));
		expect(pickerRow.textContent).toContain(
			SETTINGS_COPY.rows["automation.moveQualityChipsFor"].label
		);
		const picker = q(pickerRow, "[role=tablist]");
		const options = [...picker.querySelectorAll<HTMLElement>("[role=tab]")];
		expect(options.map((o) => o.dataset.value)).toEqual(["mine", "theirs", "both"]);
		expect(options.map((o) => o.textContent?.trim())).toEqual(["You", "Opponent", "Both"]);
		expect(DEFAULT_SETTINGS.automation.moveQualityChipsFor).toBe("both");
		expect(picker.dataset.value).toBe("both");
		expect(q(picker, '[data-value="both"]').getAttribute("aria-selected")).toBe("true");
		expect(picker.getAttribute("aria-disabled")).toBeNull();
		// A pick writes the leaf, and only it.
		click(q(picker, '[data-value="mine"]'));
		await dom.tick(0);
		expect(h.patches.at(-1)).toEqual({ automation: { moveQualityChipsFor: "mine" } });
		expect(h.settings().automation.moveQualityChipsFor).toBe("mine");
		// Move ratings off greys it out, and a click then writes nothing.
		const master = q(row(h.root, "automation.moveQualityChips"), "[role=switch]");
		click(master);
		await dom.tick(0);
		expect(picker.getAttribute("aria-disabled")).toBe("true");
		const writes = h.patches.length;
		click(q(picker, '[data-value="theirs"]'));
		await dom.tick(0);
		expect(h.patches).toHaveLength(writes);
		expect(h.settings().automation.moveQualityChipsFor).toBe("mine");
		click(master);
		await dom.tick(0);
		expect(picker.getAttribute("aria-disabled")).toBeNull();
		// Board effects is not an ancestor any more (owner, 2026-09-15): this loop used to grey the
		// picker with board effects off too, which is the dependency that was removed.
		const effects = q(row(h.root, "automation.boardEffects"), "[role=switch]");
		click(effects);
		await dom.tick(0);
		expect(picker.getAttribute("aria-disabled")).toBeNull();
		click(effects);
		await dom.tick(0);
		click(q(picker, '[data-value="theirs"]'));
		await dom.tick(0);
		expect(h.settings().automation.moveQualityChipsFor).toBe("theirs");
		expect(picker.dataset.value).toBe("theirs");
	});
	it("forced-mate sounds sit beneath rating sounds and cannot change until rating sounds are on", async () => {
		const h = await mountSettings();
		const ratingRow = row(h.root, "automation.moveRatingSounds");
		const forcedRow = row(h.root, "automation.forcedMateSounds");
		expect(ratingRow.nextElementSibling).toBe(forcedRow);
		const ratingSounds = q(ratingRow, "[role=switch]");
		const forced = q(forcedRow, "[role=switch]");
		const disabled = (): boolean => forced.getAttribute("aria-disabled") === "true";
		// Rating sounds ship off, so the forced-mate switch starts greyed with its default kept.
		expect(h.settings().automation.moveRatingSounds).toBe(false);
		expect(disabled()).toBe(true);
		click(forced);
		await dom.tick(0);
		expect(h.settings().automation.forcedMateSounds).toBe(true);
		expect(h.patches.some((p) => p.automation?.forcedMateSounds !== undefined)).toBe(false);
		// Rating sounds on: the switch is live and toggles its own leaf only.
		click(ratingSounds);
		await dom.tick(0);
		expect(disabled()).toBe(false);
		click(forced);
		await dom.tick(0);
		expect(h.settings().automation.forcedMateSounds).toBe(false);
		expect(h.settings().automation.moveRatingSounds).toBe(true);
		click(forced);
		await dom.tick(0);
		expect(h.settings().automation.forcedMateSounds).toBe(true);
		// Move ratings off greys it again, whatever rating sounds say. Board effects does not
		// (owner, 2026-09-15): it used to be the second ancestor in this loop.
		const master = q(row(h.root, "automation.moveQualityChips"), "[role=switch]");
		click(master);
		await dom.tick(0);
		expect(disabled()).toBe(true);
		click(forced);
		await dom.tick(0);
		expect(h.settings().automation.forcedMateSounds).toBe(true);
		click(master);
		await dom.tick(0);
		expect(disabled()).toBe(false);
		const effects = q(row(h.root, "automation.boardEffects"), "[role=switch]");
		click(effects);
		await dom.tick(0);
		expect(disabled()).toBe(false);
		click(effects);
		await dom.tick(0);
		click(ratingSounds);
		await dom.tick(0);
		expect(disabled()).toBe(true);
	});
	it.each([
		["strength.matchOpponentRating", "strength.personaEloOffset", "[role=slider]"],
		["automation.highlightMoves", "automation.highlightStyle", ".sl-chip-group"],
		// `automation.boardEffects` → `automation.moveQualityChips` was a row of this table until
		// 2026-09-15, when the owner made the two switches independent; the test below replaces it.
		// The side picker took the place directly beneath move ratings (owner, 2026-09-15); rating
		// sounds now sit beneath the picker, still gated by move ratings (the tests above and below).
		["automation.moveQualityChips", "automation.moveQualityChipsFor", "[role=tablist]"],
		["display.virtualCursor", "display.cursorEffects", "[role=switch]"],
	] as const)(
		"%s gates %s, which sits directly beneath it",
		async (switchPath, dependant, control) => {
			const h = await mountSettings();
			const master = row(h.root, switchPath);
			const dependent = row(h.root, dependant);
			expect(master.nextElementSibling).toBe(dependent);
			const disabled = (): boolean => q(dependent, control).getAttribute("aria-disabled") === "true";
			// Every one of these switches ships on, so its dependant starts enabled.
			expect(disabled()).toBe(false);
			click(q(master, "[role=switch]"));
			await dom.tick(0);
			expect(disabled()).toBe(true);
			click(q(master, "[role=switch]"));
			await dom.tick(0);
			expect(disabled()).toBe(false);
		}
	);

	// Owner, 2026-09-15: "Board effects and move ratings can be enabled/disabled individually."
	it("board effects greys nothing in the rating chain, though move ratings still sits beneath it", async () => {
		const h = await mountSettings();
		const effectsRow = row(h.root, "automation.boardEffects");
		const ratingsRow = row(h.root, "automation.moveQualityChips");
		expect(effectsRow.nextElementSibling).toBe(ratingsRow);
		// Rating sounds on, so the forced-mate row is live before board effects are touched.
		click(q(row(h.root, "automation.moveRatingSounds"), "[role=switch]"));
		await dom.tick(0);
		click(q(effectsRow, "[role=switch]"));
		await dom.tick(0);
		expect(h.settings().automation.boardEffects).toBe(false);
		for (const [path, control] of [
			["automation.moveQualityChips", "[role=switch]"],
			["automation.moveQualityChipsFor", "[role=tablist]"],
			["automation.moveRatingSounds", "[role=switch]"],
			["automation.forcedMateSounds", "[role=switch]"],
		] as const)
			expect(q(row(h.root, path), control).getAttribute("aria-disabled")).not.toBe("true");
		// And each still writes its own leaf with board effects off.
		click(q(ratingsRow, "[role=switch]"));
		await dom.tick(0);
		expect(h.settings().automation.moveQualityChips).toBe(false);
		expect(h.patches.at(-1)).toEqual({ automation: { moveQualityChips: false } });
	});

	it("readouts: the label-only sliders carry a numeric readout, the numeric ones do not", async () => {
		const h = await mountSettings();
		for (const path of ["timing.varianceScale", "execution.motorSpeed"] as const) {
			const r = row(h.root, path);
			expect(r.querySelector(".sl-slider--has-readout")).not.toBeNull();
			key(q(r, "[role=slider]"), "keydown", { key: "ArrowRight" });
			expect(q(r, ".sl-slider__readout").textContent).toMatch(/×$/);
		}
		for (const path of ["timing.baseSpeed", "timing.premoveTendency", "strength.targetElo"] as const)
			expect(row(h.root, path).querySelector(".sl-slider--has-readout")).toBeNull();
	});

	it("a category remembered under the old layout falls back to All", async () => {
		expect(isSectionId("execution")).toBe(false);
		expect(isSectionId("display")).toBe(false);
		expect(isSectionId("hand")).toBe(false);
		const content = document.createElement("div");
		document.body.append(content);
		const store = fakeStore(makeSnapshot());
		const ui: PanelUiState = {
			tab: "settings",
			updateAvailable: false,
			updateDismissed: false,
			settingsCategory: "execution",
		};
		const cleanup = await createSettingsView({
			setSettings: async () => normalizeSettings({}),
		}).mount({
			router: noRouter,
			container: content,
			store,
			snapshot: store.snapshot,
			ui,
			signal: new AbortController().signal,
		});
		const sections = [...content.querySelectorAll<HTMLElement>("[data-section]")];
		expect(sections.filter((s) => !s.hidden)).toHaveLength(SECTIONS.length);
		expect(
			content
				.querySelector('.sl-settings__jump .sl-chip[data-value="all"]')
				?.getAttribute("aria-pressed")
		).toBe("true");
		cleanup();
		content.remove();
	});
});
