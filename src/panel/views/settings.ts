/**
 * Settings view (Appendix F §4.6, §7.2; Part I §4.4). Sections Strength · Timing · Execution ·
 * Keybinds · Display · Account · Advanced, each row built from the declarative table in
 * `settings/rows.ts` and laid out by `settings/sections.ts`. Every change writes through
 * `setSettings` (which normalises and clamps); the view clamps what it shows and re-renders from
 * the stored result and from every snapshot. Hands-off (§13.4): the whole view is disabled —
 * the shell locks the content root and the view mirrors it on its own root and controls.
 * Jump chips follow the scroll through an `IntersectionObserver` (disposed on unmount). The
 * view never calls `focus()`, `alert()` or opens tabs itself.
 */

import { ttsGetVoices as chromeTtsGetVoices } from "@core/chrome/tts";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MSG, type PanelSnapshot } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { log } from "@core/logger";
import { getLicenseKey as storedLicenseKey } from "@core/storage/license-storage";
import { type SettingsPatch, setSettings as storeSettings } from "@core/storage/settings-storage";
import type { Keybind, LicenseState, Settings } from "@typedefs/settings";
import type { TimingLogEntry } from "@typedefs/timing";
import { type ButtonHandle, createButton } from "../components/button";
import { type ChipGroupHandle, createChipGroup } from "../components/chip";
import { createKeybindCapture, formatKeybind } from "../components/keybind";
import { closePopovers, openPopover, type PopoverHandle } from "../components/popover";
import { createSegment } from "../components/segment";
import { createSlider } from "../components/slider";
import { showToast } from "../components/toast";
import { createToggle } from "../components/toggle";
import { COPY, SETTINGS_COPY } from "../copy";
import { mountIcons } from "../icons-mount";
import { isHandsOff } from "../router";
import { instantiate, part } from "../template";
import type { Cleanup, View, ViewContext } from "../view";
import { createSelect, createStepper, type SelectOption } from "./settings/controls";
import {
	clampRowValue,
	formatTimeControl,
	getAtPath,
	type KeybindAction,
	PROFILE_FOR_TC_CLASS,
	patchAtPath,
	type RowSpec,
	rowFor,
	type SettingsLeafPath,
	type TcClass,
	tcClass,
} from "./settings/rows";
import { SECTIONS, type SectionSpec } from "./settings/sections";
import sectionHeaderHtml from "./templates/components/section.html?raw";
import confirmHtml from "./templates/settings/confirm.html?raw";
import licenseHtml from "./templates/settings/license.html?raw";
import rowHtml from "./templates/settings/row.html?raw";
import sectionHtml from "./templates/settings/section.html?raw";
import valueHtml from "./templates/settings/value.html?raw";
import settingsHtml from "./templates/settings.html?raw";

export interface SettingsViewDeps {
	setSettings: (patch: SettingsPatch) => Promise<Settings>;
	getLicenseKey: () => Promise<string | null>;
	ttsGetVoices: () => Promise<chrome.tts.TtsVoice[]>;
	version: string;
	build: string;
}

const KEYBIND_ACTIONS: readonly KeybindAction[] = [
	"playMove",
	"toggleAutoMove",
	"disable",
	"speakMove",
];

const LICENSE_VISIBLE_GROUPS = 2;
const LICENSE_MASK_CHAR = "•";
const PROFILES_NOT_PRESELECTED: ReadonlySet<Settings["timing"]["profile"]> = new Set([
	"manual",
	"custom",
]);

interface RowControl {
	el: HTMLElement;
	setValue(settings: Settings): void;
	setDisabled(disabled: boolean): void;
	dispose(): void;
}

interface RowHost {
	settings(): Settings;
	write(patch: SettingsPatch): void;
	detectedTc(): TcClass | null;
	detectedLabel(): string | null;
	voices(): readonly SelectOption[];
}

function sameKeybind(a: Keybind, b: Keybind): boolean {
	return (
		a.key === b.key &&
		a.altKey === b.altKey &&
		a.ctrlKey === b.ctrlKey &&
		a.metaKey === b.metaKey &&
		a.shiftKey === b.shiftKey
	);
}

/** "SL-7F3K-AB12-CD34" → "SL-7F3K-••••-••••". */
export function maskLicenseKey(key: string): string {
	return key
		.split("-")
		.map((group, i) => (i < LICENSE_VISIBLE_GROUPS ? group : LICENSE_MASK_CHAR.repeat(group.length)))
		.join("-");
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

function planText(license: LicenseState): string {
	if (license.status !== "valid") return SETTINGS_COPY.account.planInactive;
	return license.expiresAt
		? SETTINGS_COPY.account.plan(formatDate(license.expiresAt))
		: SETTINGS_COPY.account.planNoExpiry;
}

function deviceText(): string {
	const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
	const chrome = /Chrome\/(\d+)/.exec(ua);
	const platform = /\(([^;)]+)/.exec(ua);
	return SETTINGS_COPY.account.device(
		platform?.[1]?.trim() || SETTINGS_COPY.account.platformUnknown,
		chrome?.[1] ? SETTINGS_COPY.account.browser(chrome[1]) : SETTINGS_COPY.account.browserUnknown
	);
}

// ── row builders ────────────────────────────────────────────────────────────────────────────

function newRow(spec: { path?: SettingsLeafPath; label: string; help?: string }): {
	el: HTMLElement;
	control: HTMLElement;
	help: HTMLElement;
	note: HTMLElement;
} {
	const el = instantiate(rowHtml);
	if (spec.path) el.dataset.path = spec.path;
	part(el, ".sl-settings-row__label").textContent = spec.label;
	const help = part(el, ".sl-settings-row__help");
	if (spec.help) {
		help.textContent = spec.help;
		help.hidden = false;
	}
	return {
		el,
		control: part(el, ".sl-settings-row__control"),
		help,
		note: part(el, ".sl-settings-row__note"),
	};
}

function buildRow(spec: RowSpec, host: RowHost): RowControl {
	const row = newRow(spec);
	const value = (): unknown => getAtPath(host.settings(), spec.path);
	switch (spec.kind) {
		case "toggle": {
			row.el.classList.add("sl-settings-row--toggle");
			const toggle = createToggle(row.control, {
				label: spec.label,
				checked: value() === true,
				onChange: (checked) => host.write(patchAtPath(spec.path, checked)),
			});
			return {
				el: row.el,
				setValue: (s) => toggle.update({ checked: getAtPath(s, spec.path) === true }),
				setDisabled: (d) => toggle.update({ disabled: d }),
				dispose: () => toggle.dispose(),
			};
		}
		case "slider": {
			row.el.classList.add("sl-settings-row--stack");
			const slider = createSlider(row.control, {
				min: spec.min,
				max: spec.max,
				step: spec.step,
				value: clampRowValue(spec.path, Number(value())),
				label: spec.valueLabel,
				format: spec.format,
				ariaLabel: spec.label,
				...(spec.scale ? { scale: spec.scale } : {}),
				...(spec.threshold ? { threshold: spec.threshold } : {}),
				...(spec.danger ? { danger: spec.danger } : {}),
				...(spec.dangerHint ? { dangerHint: spec.dangerHint } : {}),
				onChange: (v, commit) => {
					if (commit) host.write(patchAtPath(spec.path, clampRowValue(spec.path, v)));
				},
			});
			return {
				el: row.el,
				setValue: (s) =>
					slider.update({ value: clampRowValue(spec.path, Number(getAtPath(s, spec.path))) }),
				setDisabled: (d) => slider.update({ disabled: d }),
				dispose: () => slider.dispose(),
			};
		}
		case "chips":
			return buildChips(spec, row, host);
		case "segment": {
			const toId = (v: unknown): string =>
				spec.boolean ? (v === true ? spec.boolean[1] : spec.boolean[0]) : String(v);
			const segment = createSegment<string>(row.control, {
				items: spec.items.map((i) => ({ id: i.id, label: i.label })),
				value: toId(value()),
				ariaLabel: spec.label,
				onChange: (id) =>
					host.write(patchAtPath(spec.path, spec.boolean ? id === spec.boolean[1] : id)),
			});
			return {
				el: row.el,
				setValue: (s) => segment.update({ value: toId(getAtPath(s, spec.path)) }),
				setDisabled: (d) => segment.update({ disabled: d }),
				dispose: () => segment.dispose(),
			};
		}
		case "stepper": {
			const toValue = (v: unknown): number | null =>
				spec.auto && v === "auto" ? null : clampRowValue(spec.path, Number(v));
			const stepper = createStepper(row.control, {
				min: spec.min,
				max: spec.max,
				value: toValue(value()) ?? spec.min - 1,
				ariaLabel: spec.label,
				...(spec.format ? { format: spec.format } : {}),
				...(spec.auto ? { auto: true } : {}),
				onChange: (v) => host.write(patchAtPath(spec.path, v === null ? "auto" : v)),
			});
			if (spec.auto && value() === "auto") stepper.update({ value: null });
			return {
				el: row.el,
				setValue: (s) => stepper.update({ value: toValue(getAtPath(s, spec.path)) }),
				setDisabled: (d) => stepper.update({ disabled: d }),
				dispose: () => stepper.dispose(),
			};
		}
		case "select": {
			const voices = spec.options === "voices";
			const options = (): readonly SelectOption[] =>
				voices
					? host.voices()
					: (spec.options as ReadonlyArray<{ id: string; label: string }>).map((o) => ({
							value: o.id,
							label: o.label,
						}));
			const toValue = (v: unknown): string =>
				v === null || v === undefined
					? ""
					: typeof v === "number"
						? String(clampRowValue(spec.path, v))
						: String(v);
			const select = createSelect(row.control, {
				options: options(),
				value: toValue(value()),
				ariaLabel: spec.label,
				onChange: (v) => {
					const stored = voices ? (v === "" ? null : v) : typeof value() === "number" ? Number(v) : v;
					host.write(patchAtPath(spec.path, stored));
				},
			});
			return {
				el: row.el,
				setValue: (s) => select.update({ options: options(), value: toValue(getAtPath(s, spec.path)) }),
				setDisabled: (d) => select.update({ disabled: d }),
				dispose: () => select.dispose(),
			};
		}
		case "keybind":
			return buildKeybind(spec, row, host);
	}
}

function buildChips(
	spec: Extract<RowSpec, { kind: "chips" }>,
	row: ReturnType<typeof newRow>,
	host: RowHost
): RowControl {
	row.el.classList.add("sl-settings-row--stack");
	const isPreset = spec.path === "timing.profile";
	/** Preset chips: the user's pick this session overrides the detected pre-selection. */
	let overridden = false;

	function selectedFor(settings: Settings): string {
		const stored = String(getAtPath(settings, spec.path));
		if (!isPreset || overridden) return stored;
		const detected = host.detectedTc();
		if (!detected || PROFILES_NOT_PRESELECTED.has(stored as Settings["timing"]["profile"]))
			return stored;
		return PROFILE_FOR_TC_CLASS[detected];
	}

	function renderHelp(selected: string | null): void {
		const text = (selected && spec.descriptions?.[selected]) || spec.help || "";
		row.help.textContent = text;
		row.help.hidden = !text;
	}

	function renderNote(selected: string | null): void {
		if (!isPreset) return;
		const detected = host.detectedTc();
		const label = host.detectedLabel();
		for (const chip of row.el.querySelectorAll<HTMLElement>(".sl-chip")) {
			if (detected && chip.dataset.value === PROFILE_FOR_TC_CLASS[detected])
				chip.dataset.detected = "true";
			else delete chip.dataset.detected;
		}
		const text =
			!detected || !label
				? ""
				: selected === PROFILE_FOR_TC_CLASS[detected]
					? COPY.timing.detected(label)
					: COPY.timing.overrides;
		row.note.textContent = text;
		row.note.hidden = !text;
	}

	const chips: ChipGroupHandle<string> = createChipGroup<string>(row.control, {
		items: spec.items.map((i) => ({ id: i.id, label: i.label })),
		value: selectedFor(host.settings()),
		onChange: (id) => {
			if (id === null) return;
			overridden = true;
			renderHelp(id);
			renderNote(id);
			host.write(patchAtPath(spec.path, id));
		},
	});
	renderHelp(chips.value);
	renderNote(chips.value);
	return {
		el: row.el,
		setValue: (s) => {
			const selected = selectedFor(s);
			chips.update({ value: selected });
			renderHelp(selected);
			renderNote(selected);
		},
		setDisabled: (d) => chips.update({ disabled: d }),
		dispose: () => chips.dispose(),
	};
}

function buildKeybind(
	spec: Extract<RowSpec, { kind: "keybind" }>,
	row: ReturnType<typeof newRow>,
	host: RowHost
): RowControl {
	row.el.classList.add("sl-settings-row--keybind");
	const label = COPY.keybind.actions[spec.action];
	const otherActions = KEYBIND_ACTIONS.filter((a) => a !== spec.action);
	/** `onSwap` writes both bindings; the `onChange` that follows it must not write again. */
	let swapped = false;
	/** The action found by the last `conflicts` check — `onSwap` uses it, not the label. */
	let conflictAction: KeybindAction | null = null;
	const handle = createKeybindCapture(row.control, {
		label,
		value: host.settings().keybinds[spec.action],
		global: host.settings().keybinds.global,
		conflicts: (kb) => {
			conflictAction = otherActions.find((a) => sameKeybind(host.settings().keybinds[a], kb)) ?? null;
			return conflictAction ? COPY.keybind.actions[conflictAction] : null;
		},
		onSwap: (kb) => {
			const other = conflictAction;
			conflictAction = null;
			if (!other) return;
			swapped = true;
			host.write({
				keybinds: { [spec.action]: kb, [other]: host.settings().keybinds[spec.action] },
			});
		},
		onChange: (kb) => {
			if (kb) showToast("success", COPY.toast.keybind(label, formatKeybind(kb)));
			if (swapped) {
				swapped = false;
				return;
			}
			host.write({ keybinds: { [spec.action]: kb ?? DEFAULT_SETTINGS.keybinds[spec.action] } });
		},
	});
	return {
		el: row.el,
		setValue: (s) => handle.update({ value: s.keybinds[spec.action], global: s.keybinds.global }),
		setDisabled: (d) => handle.update({ disabled: d }),
		dispose: () => handle.dispose(),
	};
}

// ── the view ────────────────────────────────────────────────────────────────────────────────

export function createSettingsView(overrides: Partial<SettingsViewDeps> = {}): View {
	const deps: SettingsViewDeps = {
		setSettings: storeSettings,
		getLicenseKey: storedLicenseKey,
		ttsGetVoices: chromeTtsGetVoices,
		version: __SL_VERSION__,
		build: __SL_BUILD__,
		...overrides,
	};

	return {
		mount(ctx: ViewContext): Cleanup {
			const root = instantiate(settingsHtml);
			const jumpHost = part(root, ".sl-settings__jump");
			const sectionsHost = part(root, ".sl-settings__sections");
			part(root, ".sl-settings__title").textContent = COPY.workspace.settingsTitle;
			part(root, ".sl-settings__intro").textContent = COPY.workspace.settingsBody;
			const search = part<HTMLInputElement>(root, ".sl-settings__search");
			search.placeholder = COPY.workspace.searchPlaceholder;
			search.setAttribute("aria-label", COPY.workspace.searchSettings);
			const emptySearch = part(root, ".sl-settings__empty");
			emptySearch.textContent = COPY.workspace.noSettings;
			const saveStatus = part(root, ".sl-settings__save");
			saveStatus.textContent = COPY.workspace.saved;
			jumpHost.setAttribute("aria-label", SETTINGS_COPY.jump);
			part(root, ".sl-settings__footer-version").textContent = COPY.footer(deps.version, deps.build);
			part(root, '.sl-settings__footer-notice[data-notice="engine"]').textContent =
				COPY.notices.engine;
			part(root, '.sl-settings__footer-notice[data-notice="timing"]').textContent =
				COPY.notices.timing;

			let settings: Settings = ctx.snapshot?.settings ?? { ...DEFAULT_SETTINGS };
			let license: LicenseState = ctx.snapshot?.license ?? { status: "unknown", checkedAt: 0 };
			let locked = ctx.snapshot ? isHandsOff(ctx.snapshot) : false;
			let detected: TcClass | null = null;
			let detectedLabel: string | null = null;
			let voiceOptions: readonly SelectOption[] = [{ value: "", label: SETTINGS_COPY.voice.default }];
			const controls = new Map<SettingsLeafPath, RowControl>();
			const buttons: ButtonHandle[] = [];
			const disposers: Array<() => void> = [];
			/** Non-setting rows (plan) re-rendered on every snapshot. */
			const refreshers: Array<() => void> = [];
			let queue: Promise<void> = Promise.resolve();
			let pendingWrites = 0;
			let writeFailed = false;

			function write(patch: SettingsPatch): void {
				if (locked || ctx.signal.aborted) return;
				if (pendingWrites === 0) writeFailed = false;
				pendingWrites += 1;
				saveStatus.textContent = COPY.workspace.saving;
				saveStatus.dataset.state = "saving";
				queue = queue
					.then(async () => {
						if (locked || ctx.signal.aborted) return;
						const next = await deps.setSettings(patch);
						if (ctx.signal.aborted) return;
						settings = next;
						refreshValues();
					})
					.catch((error: unknown) => {
						log.warn("settings: write failed", error);
						if (ctx.signal.aborted) return;
						refreshValues();
						writeFailed = true;
					})
					.finally(() => {
						pendingWrites -= 1;
						if (ctx.signal.aborted || pendingWrites > 0) return;
						saveStatus.textContent = writeFailed ? COPY.workspace.saveFailed : COPY.workspace.saved;
						saveStatus.dataset.state = writeFailed ? "error" : "saved";
					});
			}

			function readDetection(snapshot: PanelSnapshot | null): void {
				const tc = snapshot?.session.timeControl;
				detected = tc ? tcClass(tc) : null;
				detectedLabel = tc ? formatTimeControl(tc) : null;
			}
			readDetection(ctx.snapshot);

			const host: RowHost = {
				settings: () => settings,
				write,
				detectedTc: () => detected,
				detectedLabel: () => detectedLabel,
				voices: () => voiceOptions,
			};

			function disabledFor(path: SettingsLeafPath): boolean {
				if (locked) return true;
				if (path === "automation.autoQueueDelayEnabled") return !settings.automation.autoQueue;
				if (path === "automation.autoQueueDelayMaxMinutes") {
					return !settings.automation.autoQueue || !settings.automation.autoQueueDelayEnabled;
				}
				return false;
			}

			function refreshValues(): void {
				for (const [path, control] of controls) {
					control.setValue(settings);
					control.setDisabled(disabledFor(path));
				}
			}

			function applyLock(): void {
				if (locked) closePopovers(); // a confirm left open must not act mid-game (§13.4)
				root.classList.toggle("sl-settings--locked", locked);
				if (locked) root.setAttribute("aria-disabled", "true");
				else root.removeAttribute("aria-disabled");
				jump.update({ disabled: locked });
				search.disabled = locked;
				for (const b of buttons) b.update({ disabled: locked });
				for (const [path, control] of controls) control.setDisabled(disabledFor(path));
			}

			// ── sections and rows ──
			const sectionEls: HTMLElement[] = [];
			for (const section of SECTIONS) {
				const el = instantiate(sectionHtml);
				el.dataset.section = section.id;
				const header = instantiate(sectionHeaderHtml);
				part(header, ".sl-section__title").textContent = section.title;
				el.prepend(header);
				const rows = part(el, ".sl-settings__rows");
				for (const path of section.rows) {
					const control = buildRow(rowFor(path), host);
					controls.set(path, control);
					rows.append(control.el);
				}
				if (section.id === "account") buildAccount(section, rows);
				if (section.id === "advanced") buildAdvanced(section, rows);
				sectionsHost.append(el);
				sectionEls.push(el);
			}

			function filterSettings(): void {
				const query = search.value.trim().toLocaleLowerCase();
				let found = false;
				for (const section of sectionEls) {
					const titleMatches = (section.querySelector(".sl-section__title")?.textContent ?? "")
						.toLocaleLowerCase()
						.includes(query);
					let sectionMatches = false;
					for (const row of section.querySelectorAll<HTMLElement>(
						".sl-settings-row, .sl-settings-advanced__actions, .sl-settings-account__actions"
					)) {
						const matches =
							!query || titleMatches || (row.textContent ?? "").toLocaleLowerCase().includes(query);
						row.hidden = !matches;
						sectionMatches ||= matches;
					}
					section.hidden = !sectionMatches;
					found ||= sectionMatches;
				}
				emptySearch.hidden = found;
				jumpHost.hidden = query.length > 0;
			}
			search.addEventListener("input", filterSettings);
			disposers.push(() => search.removeEventListener("input", filterSettings));

			// ── jump chips + scroll-spy ──
			const jump = createChipGroup<string>(jumpHost, {
				items: SECTIONS.map((s) => ({ id: s.id, label: s.title })),
				value: SECTIONS[0]?.id ?? null,
				onChange: (id) => {
					const target = sectionEls.find((el) => el.dataset.section === id);
					if (target && typeof target.scrollIntoView === "function")
						target.scrollIntoView({ block: "start" });
				},
			});
			let observer: IntersectionObserver | null = null;
			if (typeof IntersectionObserver === "function") {
				const visible = new Set<Element>();
				observer = new IntersectionObserver((entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) visible.add(entry.target);
						else visible.delete(entry.target);
					}
					const first = sectionEls.find((el) => visible.has(el));
					const id = first?.dataset.section;
					if (id && jump.value !== id) jump.update({ value: id });
				});
				for (const el of sectionEls) observer.observe(el);
			}

			// ── account ──
			function buildAccount(_section: SectionSpec, rows: HTMLElement): void {
				const licenseRow = newRow({ label: COPY.account.license });
				licenseRow.el.dataset.row = "license";
				const licenseEl = instantiate(licenseHtml);
				const keyEl = part(licenseEl, ".sl-settings-license__key");
				keyEl.textContent = SETTINGS_COPY.account.noKey;
				licenseRow.control.append(licenseEl);
				let key: string | null = null;
				let revealed = false;
				let revealTimer: ReturnType<typeof setTimeout> | null = null;
				const clearReveal = (): void => {
					if (revealTimer !== null) {
						clearTimeout(revealTimer);
						revealTimer = null;
					}
				};
				const renderKey = (): void => {
					keyEl.textContent = key ? (revealed ? key : maskLicenseKey(key)) : SETTINGS_COPY.account.noKey;
					reveal.update({
						icon: revealed ? "action.hide" : "action.reveal",
						ariaLabel: revealed ? COPY.login.hide : COPY.login.reveal,
					});
				};
				const reveal = createButton(licenseEl, {
					label: "",
					variant: "ghost",
					size: "sm",
					icon: "action.reveal",
					ariaLabel: COPY.login.reveal,
					onClick: () => {
						if (!key) return;
						clearReveal();
						revealed = !revealed;
						if (revealed)
							revealTimer = setTimeout(() => {
								revealTimer = null;
								revealed = false;
								renderKey();
							}, UI_TIMINGS.licenseRevealMs);
						renderKey();
					},
				});
				reveal.el.classList.add("sl-settings-license__reveal");
				buttons.push(reveal);
				disposers.push(clearReveal);
				deps
					.getLicenseKey()
					.then((k) => {
						if (ctx.signal.aborted) return;
						key = k;
						renderKey();
					})
					.catch((error: unknown) => log.debug("settings: license key read failed", error));
				rows.append(licenseRow.el);

				const planRow = newRow({ label: COPY.account.plan });
				planRow.el.dataset.row = "plan";
				const planValue = instantiate(valueHtml);
				planRow.control.append(planValue);
				rows.append(planRow.el);
				refreshers.push(() => {
					planValue.textContent = planText(license);
				});

				const deviceRow = newRow({ label: COPY.account.device });
				deviceRow.el.dataset.row = "device";
				const deviceValue = instantiate(valueHtml);
				deviceValue.textContent = deviceText();
				deviceRow.control.append(deviceValue);
				rows.append(deviceRow.el);

				const actions = document.createElement("div");
				actions.className = "sl-row sl-settings-account__actions";
				const manage = createButton(actions, {
					label: SETTINGS_COPY.account.manageDevices,
					variant: "ghost",
					size: "sm",
					icon: "action.external",
				});
				manage.el.classList.add("sl-settings-account__manage");
				manage.el.dataset.action = "open-url";
				manage.el.dataset.url = "website";
				const signOut = createButton(actions, {
					label: COPY.account.signOut,
					variant: "ghost",
					dangerText: true,
					size: "sm",
					onClick: () =>
						confirm(signOut.el, COPY.account.signOutConfirm, COPY.account.signOut, () => {
							ctx.store
								.dispatch({ type: MSG.PANEL_LOGOUT })
								.catch((error: unknown) => log.warn("settings: sign out failed", error));
						}),
				});
				signOut.el.classList.add("sl-settings-account__signout");
				buttons.push(manage, signOut);
				rows.append(actions);
			}

			// ── advanced ──
			function buildAdvanced(_section: SectionSpec, rows: HTMLElement): void {
				const actions = document.createElement("div");
				actions.className = "sl-stack sl-settings-advanced__actions";
				const exportButton = createButton(actions, {
					label: SETTINGS_COPY.advanced.exportTimingLog,
					variant: "ghost",
					size: "sm",
					icon: "action.export",
					onClick: () => {
						ctx.store
							.dispatch({ type: MSG.PANEL_EXPORT_TIMING_LOG })
							.then((entries) => {
								if (ctx.signal.aborted) return;
								exportTimingLog(entries);
								showToast("success", SETTINGS_COPY.advanced.exported(entries.length));
							})
							.catch((error: unknown) => {
								log.warn("settings: export failed", error);
								showToast("danger", SETTINGS_COPY.advanced.exportFailed);
							});
					},
				});
				exportButton.el.classList.add("sl-settings-advanced__export");
				const reset = createButton(actions, {
					label: SETTINGS_COPY.advanced.resetAll,
					variant: "ghost",
					dangerText: true,
					size: "sm",
					onClick: () =>
						confirm(reset.el, COPY.account.resetConfirm, COPY.account.reset, () =>
							write(DEFAULT_SETTINGS)
						),
				});
				reset.el.classList.add("sl-settings-advanced__reset");
				buttons.push(exportButton, reset);
				rows.append(actions);
			}

			// ── confirm popover ──
			function confirm(
				anchor: HTMLElement,
				text: string,
				confirmLabel: string,
				onConfirm: () => void
			): void {
				if (locked) return;
				const el = instantiate(confirmHtml);
				part(el, ".sl-settings-confirm__text").textContent = text;
				const actions = part(el, ".sl-settings-confirm__actions");
				let handle: PopoverHandle | null = null;
				const cancel = createButton(actions, {
					label: COPY.account.cancel,
					variant: "ghost",
					size: "sm",
					onClick: () => handle?.close(),
				});
				cancel.el.classList.add("sl-settings-confirm__cancel");
				const ok = createButton(actions, {
					label: confirmLabel,
					variant: "danger",
					size: "sm",
					onClick: () => {
						handle?.close();
						onConfirm();
					},
				});
				ok.el.classList.add("sl-settings-confirm__confirm");
				handle = openPopover(anchor, el, {
					onClose: () => {
						cancel.dispose();
						ok.dispose();
					},
				});
			}

			// ── voices (async; disabled while TTS is off) ──
			deps
				.ttsGetVoices()
				.then((voices) => {
					if (ctx.signal.aborted) return;
					voiceOptions = [
						{ value: "", label: SETTINGS_COPY.voice.default },
						...voices
							.filter((v): v is chrome.tts.TtsVoice & { voiceName: string } => !!v.voiceName)
							.map((v) => ({
								value: v.voiceName,
								label: v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName,
							})),
					];
					controls.get("display.ttsVoice")?.setValue(settings);
				})
				.catch((error: unknown) => log.debug("settings: tts voices unavailable", error));

			// ── snapshots ──
			const unsubscribe = ctx.store.subscribe((snapshot) => {
				settings = snapshot.settings;
				license = snapshot.license;
				locked = isHandsOff(snapshot);
				readDetection(snapshot);
				for (const r of refreshers) r();
				refreshValues();
				applyLock();
			});

			mountIcons(root);
			for (const r of refreshers) r();
			refreshValues();
			applyLock();
			ctx.container.append(root);

			return () => {
				unsubscribe();
				observer?.disconnect();
				observer = null;
				closePopovers();
				for (const d of disposers) d();
				for (const control of controls.values()) control.dispose();
				controls.clear();
				for (const b of buttons) b.dispose();
				jump.dispose();
				root.remove();
			};
		},
	};
}

/** Hand the timing log to the user as a JSON file (no-op where object URLs are unavailable). */
function exportTimingLog(entries: TimingLogEntry[]): void {
	if (typeof Blob !== "function" || typeof URL.createObjectURL !== "function") return;
	try {
		const blob = new Blob([JSON.stringify(entries, null, "\t")], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `sliced-timing-log-${new Date().toISOString().slice(0, 10)}.json`;
		a.hidden = true;
		document.body.append(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	} catch (error) {
		log.warn("settings: timing log download failed", error);
	}
}
