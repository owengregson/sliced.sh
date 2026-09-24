/**
 * The search box and the category chips. Category and text filters intersect; changing category
 * never moves the scroll position. The chosen category is remembered in the panel's UI state.
 */

import { type ChipGroupHandle, createChipGroup } from "../../components/chip";
import { COPY, SETTINGS_COPY } from "../../copy";
import type { PanelUiState } from "../../view";
import { isSectionId, SECTIONS } from "./sections";

export interface SettingsFilterParts {
	search: HTMLInputElement;
	jumpHost: HTMLElement;
	empty: HTMLElement;
	sections: readonly HTMLElement[];
}

export interface SettingsFilter {
	/** The category chips (the hands-off lock disables them). */
	readonly jump: ChipGroupHandle<string>;
	dispose(): void;
}

export function createSettingsFilter(parts: SettingsFilterParts, ui: PanelUiState): SettingsFilter {
	const { search, jumpHost, empty: emptySearch, sections: sectionEls } = parts;
	search.placeholder = COPY.workspace.searchPlaceholder;
	search.setAttribute("aria-label", COPY.workspace.searchSettings);
	emptySearch.textContent = COPY.workspace.noSettings;
	jumpHost.setAttribute("aria-label", SETTINGS_COPY.jump);

	let category = "all";
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
			section.hidden = !sectionMatches || (category !== "all" && section.dataset.section !== category);
			found ||= !section.hidden;
		}
		emptySearch.hidden = found;
	}
	search.addEventListener("input", filterSettings);

	const jump = createChipGroup<string>(jumpHost, {
		items: [
			{ id: "all", label: SETTINGS_COPY.all },
			...SECTIONS.map((s) => ({ id: s.id, label: s.title })),
		],
		value: category,
		onChange: (id) => {
			category = id ?? "all";
			ui.settingsCategory = category;
			filterSettings();
		},
	});
	// A category remembered under an older layout (`execution`, `display`) is not a section
	// any more; it falls back to All rather than filtering everything out.
	const remembered = ui.settingsCategory;
	category = remembered !== undefined && isSectionId(remembered) ? remembered : "all";
	jump.update({ value: category });
	filterSettings();

	return {
		jump,
		dispose() {
			search.removeEventListener("input", filterSettings);
			jump.dispose();
		},
	};
}
