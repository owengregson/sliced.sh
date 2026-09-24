/** Settings are grouped by outcome; named choices retain expandable, exact fine-tuning.
 * Writes are serialized through normalized storage and every snapshot refreshes the controls.
 * Strength stays rating-led. The Game switch owns auto-play, including saved lobby intent.
 *
 * This file composes the view from `settings/`: the row table (`rows.ts`, `sections.ts`), the
 * row controls, the write queue, the search filter and the Account / Diagnostics sections.
 */

import { ttsGetVoices as chromeTtsGetVoices } from "@core/chrome/tts";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import type { PanelSnapshot } from "@core/constants/messages";
import { log } from "@core/logger";
import { getLicenseKey as storedLicenseKey } from "@core/storage/license-storage";
import { type SettingsPatch, setSettings as storeSettings } from "@core/storage/settings-storage";
import type { LicenseState, Settings } from "@typedefs/settings";
import { createButton } from "../components/button";
import { closePopovers } from "../components/popover";
import { COPY, SETTINGS_COPY } from "../copy";
import { mountIcons } from "../icons-mount";
import { isHandsOff } from "../router";
import { instantiate, part } from "../template";
import type { Cleanup, View, ViewContext } from "../view";
import { buildAccount } from "./settings/account";
import { buildAdvanced } from "./settings/advanced";
import { createConfirm } from "./settings/confirm";
import type { SelectOption } from "./settings/controls";
import { disabledFor } from "./settings/dependencies";
import { createSettingsFilter } from "./settings/filter";
import { buildRow, type RowControl, type RowHost } from "./settings/row-control";
import { rowFor, type SettingsLeafPath } from "./settings/rows";
import type { SectionParts } from "./settings/section-parts";
import { SECTIONS, type SectionSpec } from "./settings/sections";
import { DEFAULT_VOICE_OPTIONS, voiceOptions } from "./settings/voices";
import { createWriteQueue } from "./settings/write-queue";
import sectionHeaderHtml from "./templates/components/section.html?raw";
import autoplayHtml from "./templates/settings/autoplay.html?raw";
import sectionHtml from "./templates/settings/section.html?raw";
import settingsHtml from "./templates/settings.html?raw";

export { maskLicenseKey } from "../format";

export interface SettingsViewDeps {
	setSettings: (patch: SettingsPatch) => Promise<Settings>;
	getLicenseKey: () => Promise<string | null>;
	ttsGetVoices: () => Promise<chrome.tts.TtsVoice[]>;
	version: string;
	build: string;
}

/** The Play & sessions notice: auto-play lives in Game, with a link there. */
function autoplayNotice(parts: SectionParts): HTMLElement {
	const notice = instantiate(autoplayHtml);
	part(notice, ".sl-settings-autoplay__title").textContent = SETTINGS_COPY.autoplay.title;
	part(notice, ".sl-settings-autoplay__help").textContent = SETTINGS_COPY.autoplay.help;
	const go = createButton(part(notice, ".sl-settings-autoplay__action"), {
		label: SETTINGS_COPY.autoplay.action,
		variant: "ghost",
		size: "sm",
	});
	go.el.dataset.action = "view-switch";
	go.el.dataset.tab = "game";
	parts.buttons.push(go);
	return notice;
}

/** A section's element: header, help line and its rows host. */
function sectionShell(section: SectionSpec): { el: HTMLElement; rows: HTMLElement } {
	const el = instantiate(sectionHtml);
	el.dataset.section = section.id;
	const header = instantiate(sectionHeaderHtml);
	part(header, ".sl-section__title").textContent = section.title;
	el.prepend(header);
	const rows = part(el, ".sl-settings__rows");
	const description = part(el, ".sl-settings__section-help");
	description.textContent = section.help;
	description.hidden = !section.help;
	return { el, rows };
}

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
			const sectionsHost = part(root, ".sl-settings__sections");
			part(root, ".sl-settings__title").textContent = COPY.workspace.settingsTitle;
			part(root, ".sl-settings__intro").textContent = COPY.workspace.settingsBody;
			const search = part<HTMLInputElement>(root, ".sl-settings__search");
			const saveStatus = part(root, ".sl-settings__save");
			saveStatus.textContent = COPY.workspace.saved;
			part(root, ".sl-settings__footer-version").textContent = COPY.footer(deps.version, deps.build);
			part(root, '.sl-settings__footer-notice[data-notice="engine"]').textContent =
				COPY.notices.engine;
			part(root, '.sl-settings__footer-notice[data-notice="timing"]').textContent =
				COPY.notices.timing;

			let settings: Settings = ctx.snapshot?.settings ?? { ...DEFAULT_SETTINGS };
			let license: LicenseState = ctx.snapshot?.license ?? { status: "unknown", checkedAt: 0 };
			let locked = ctx.snapshot ? isHandsOff(ctx.snapshot) : false;
			/** The opponent's detected rating (2026-09-15: the time-control detection the timing
			 * presets needed went with them). */
			let derivedTargetElo: number | undefined = ctx.snapshot?.opponent?.derivedTargetElo;
			let voices: readonly SelectOption[] = DEFAULT_VOICE_OPTIONS;
			const controls = new Map<SettingsLeafPath, RowControl>();
			const parts: SectionParts = { buttons: [], disposers: [], refreshers: [] };

			const write = createWriteQueue({
				save: deps.setSettings,
				signal: ctx.signal,
				locked: () => locked,
				current: () => settings,
				onSaved: (next) => {
					settings = next;
					refreshValues();
				},
				onFailed: () => refreshValues(),
				status: saveStatus,
			});
			const confirm = createConfirm(() => locked);

			const host: RowHost = {
				settings: () => settings,
				activeElo: () =>
					settings.strength.matchOpponentRating
						? (derivedTargetElo ?? settings.strength.targetElo)
						: settings.strength.targetElo,
				write,
				voices: () => voices,
			};

			function refreshValues(): void {
				for (const [path, control] of controls) {
					control.setValue(settings);
					control.setDisabled(disabledFor(path, settings, locked));
				}
				root.classList.toggle("sl-settings--matched-rating", settings.strength.matchOpponentRating);
			}

			function applyLock(): void {
				if (locked) closePopovers(); // a confirm left open must not act mid-game (§13.4)
				root.classList.toggle("sl-settings--locked", locked);
				if (locked) root.setAttribute("aria-disabled", "true");
				else root.removeAttribute("aria-disabled");
				filter.jump.update({ disabled: locked });
				search.disabled = locked;
				for (const b of parts.buttons) b.update({ disabled: locked });
				for (const [path, control] of controls)
					control.setDisabled(disabledFor(path, settings, locked));
			}

			// ── sections and rows ──
			const sectionEls: HTMLElement[] = [];
			for (const section of SECTIONS) {
				const { el, rows } = sectionShell(section);
				if (section.id === "automation") rows.append(autoplayNotice(parts));
				for (const path of section.rows) {
					const control = buildRow(rowFor(path), host);
					controls.set(path, control);
					rows.append(control.el);
				}
				if (section.id === "account")
					buildAccount(
						rows,
						{
							store: ctx.store,
							signal: ctx.signal,
							getLicenseKey: deps.getLicenseKey,
							license: () => license,
							confirm,
						},
						parts
					);
				if (section.id === "advanced")
					buildAdvanced(rows, { store: ctx.store, signal: ctx.signal, write, confirm }, parts);
				sectionsHost.append(el);
				sectionEls.push(el);
			}

			const filter = createSettingsFilter(
				{
					search,
					jumpHost: part(root, ".sl-settings__jump"),
					empty: part(root, ".sl-settings__empty"),
					sections: sectionEls,
				},
				ctx.ui
			);

			// ── voices (async; disabled while TTS is off) ──
			deps
				.ttsGetVoices()
				.then((available) => {
					if (ctx.signal.aborted) return;
					voices = voiceOptions(available);
					controls.get("display.ttsVoice")?.setValue(settings);
				})
				.catch((error: unknown) => log.debug("settings: tts voices unavailable", error));

			// ── snapshots ──
			function readSnapshot(snapshot: PanelSnapshot): void {
				settings = snapshot.settings;
				license = snapshot.license;
				locked = isHandsOff(snapshot);
				derivedTargetElo = snapshot.opponent?.derivedTargetElo;
			}
			const unsubscribe = ctx.store.subscribe((snapshot) => {
				readSnapshot(snapshot);
				for (const r of parts.refreshers) r();
				refreshValues();
				applyLock();
			});

			mountIcons(root);
			for (const r of parts.refreshers) r();
			refreshValues();
			applyLock();
			ctx.container.append(root);

			return () => {
				unsubscribe();
				closePopovers();
				for (const d of parts.disposers) d();
				for (const control of controls.values()) control.dispose();
				controls.clear();
				for (const b of parts.buttons) b.dispose();
				filter.dispose();
				root.remove();
			};
		},
	};
}
