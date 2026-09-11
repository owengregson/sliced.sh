/** All sidebar views share the page's captured shortcut matching and debounce. */
import { installKeybinds } from "@content/keybinds";
import { tabsQuery } from "@core/chrome/tabs";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import { DEFAULT_KEYBINDS } from "@typedefs/settings";
import type { PanelStore } from "./store";

export function installPanelKeybinds(doc: Document, store: PanelStore): () => void {
	const win = doc.defaultView;
	if (!win) return () => {};
	let disposed = false;
	const remove = installKeybinds(
		() => store.snapshot?.settings.keybinds ?? { ...DEFAULT_KEYBINDS, global: false },
		(action) => {
			void tabsQuery({ active: true, currentWindow: true })
				.then(async ([tab]) => {
					if (disposed || tab?.id === undefined) return;
					await store.dispatch({ type: MSG.PANEL_KEYBIND, tabId: tab.id, action });
				})
				.catch((error: unknown) => log.warn("panel: keybind failed", { action, error }));
		},
		{
			window: win,
			enabled: () =>
				store.snapshot !== null &&
				doc.querySelector('.sl-keybind[data-state="capturing"], .sl-keybind[data-state="conflict"]') ===
					null,
		}
	);
	return () => {
		disposed = true;
		remove();
	};
}
