/**
 * Side-panel entry (`pages/panel.html` → `js/panel.js`): boots the shell into `main#app` with
 * the SW-backed store. Everything the shell owns is disposable; the page unload tears it down.
 */

import { log } from "@core/logger";
import { bootShell, type PanelShell } from "./shell";
import { createPanelStore } from "./store";

function boot(): PanelShell | null {
	const root = document.getElementById("app");
	if (!(root instanceof HTMLElement)) {
		log.error("panel: main#app not found");
		return null;
	}
	const store = createPanelStore();
	const shell = bootShell(root, { store });
	window.addEventListener(
		"pagehide",
		() => {
			shell.dispose();
			store.dispose();
		},
		{ once: true }
	);
	return shell;
}

if (document.readyState === "loading")
	document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
else boot();
