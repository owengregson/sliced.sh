/**
 * Side-panel entry (`pages/panel.html` → `js/panel.js`): boots the shell into `main#app` with
 * the SW-backed store. Everything the shell owns is disposable; the page unload tears it down.
 *
 * The update interrupt (Appendix F §4.8) is assembled here rather than in the view registry,
 * because only the boot code knows both halves: `LOCAL_KEYS.updateVersion` — the version
 * `@service/update-check` saw on the site, which is what the copy names — and the action, which
 * is `chrome.runtime.reload()`. §12.2 ships a zip plus an unpacked folder with no `update_url`,
 * so "Restart and update" means "re-read what is on disk"; the download itself is manual.
 */

import { runtimeReload } from "@core/chrome/runtime";
import { chromeLocalGet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { bootShell, type PanelShell } from "./shell";
import { createPanelStore } from "./store";
import { createUpdateView } from "./views/update";

function onUpdate(): void {
	log.info("panel: restarting for update");
	runtimeReload();
}

/**
 * The announced version is read once, at boot. A flag that flips while the panel is open still
 * raises the interrupt (the shell mirrors `updateAvailable` live); only the version in the copy
 * would be stale, and reopening the panel corrects it.
 */
async function announcedVersion(): Promise<string | undefined> {
	try {
		return (await chromeLocalGet(LOCAL_KEYS.updateVersion)) ?? undefined;
	} catch (error) {
		log.debug("panel: updateVersion read failed", error);
		return undefined;
	}
}

async function boot(): Promise<PanelShell | null> {
	const root = document.getElementById("app");
	if (!(root instanceof HTMLElement)) {
		log.error("panel: main#app not found");
		return null;
	}
	const version = await announcedVersion();
	const store = createPanelStore();
	const shell = bootShell(root, {
		store,
		onUpdate,
		views: { update: createUpdateView(version === undefined ? { onUpdate } : { version, onUpdate }) },
		...(version === undefined ? {} : { version }),
	});
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

function start(): void {
	void boot().catch((error: unknown) => log.error("panel: boot failed", error));
}

if (document.readyState === "loading")
	document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
