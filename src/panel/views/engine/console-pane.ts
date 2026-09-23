/** The live log pane fed by `logging-bridge.ts`, with its level control. */

import { LIMITS } from "@core/constants/limits";
import type { LogStreamMessage } from "@core/constants/messages";
import { LOG_LEVELS, type LogEntry, levelAllows } from "@core/logger";
import type { LogLevel } from "@typedefs/settings";
import { COPY } from "../../copy";
import type { LoggingBridge } from "../../logging-bridge";
import { instantiate, part } from "../../template";
import consoleRowHtml from "../templates/engine-console-row.html?raw";
import optionHtml from "../templates/engine-option.html?raw";
import { argText, sourceLabel, timeOfDay } from "./format";

export interface ConsoleParts {
	rows: HTMLElement;
	pane: HTMLElement;
	empty: HTMLElement;
	level: HTMLSelectElement;
}

/** Wire the pane to `logging`; the returned cleanup unsubscribes and disposes the bridge. */
export function mountConsolePane(
	parts: ConsoleParts,
	logging: LoggingBridge,
	initialLevel: LogLevel
): () => void {
	const { rows: consoleRows, pane: consolePane, empty: consoleEmpty, level: levelSelect } = parts;
	for (const level of LOG_LEVELS) {
		const option = instantiate<HTMLOptionElement>(optionHtml);
		option.value = level;
		option.textContent = COPY.engineView.levels[level];
		levelSelect.append(option);
	}
	levelSelect.value = initialLevel;
	levelSelect.setAttribute("aria-label", COPY.engineView.level);

	function appendConsole(entry: LogEntry): void {
		const row = instantiate(consoleRowHtml);
		row.dataset.level = entry.level;
		part(row, ".sl-engine__console-time").textContent = timeOfDay(entry.meta.timestamp);
		part(row, ".sl-engine__console-level").textContent = entry.level;
		part(row, ".sl-engine__console-source").textContent = sourceLabel(entry.meta.source);
		part(row, ".sl-engine__console-text").textContent = entry.args.map(argText).join(" ");
		consoleRows.append(row);
	}

	function renderConsole(): void {
		consoleRows.replaceChildren();
		let shown = 0;
		for (const entry of logging.entries) {
			if (!levelAllows(logging.level, entry.level)) continue;
			appendConsole(entry);
			shown += 1;
		}
		consoleEmpty.hidden = shown > 0;
		consolePane.scrollTop = consolePane.scrollHeight;
	}

	const unsubscribeLogging = logging.subscribe((message: LogStreamMessage) => {
		if (message.kind === "backlog") {
			renderConsole();
			return;
		}
		if (!levelAllows(logging.level, message.entry.level)) return;
		appendConsole(message.entry);
		consoleEmpty.hidden = true;
		while (consoleRows.childElementCount > LIMITS.logRingMax) consoleRows.firstElementChild?.remove();
		consolePane.scrollTop = consolePane.scrollHeight;
	});
	const onLevelChange = (): void => {
		const next = levelSelect.value;
		if (!LOG_LEVELS.includes(next as LogLevel)) return;
		logging.setLevel(next as LogLevel);
		renderConsole();
	};
	levelSelect.addEventListener("change", onLevelChange);
	renderConsole();

	return () => {
		unsubscribeLogging();
		levelSelect.removeEventListener("change", onLevelChange);
		logging.dispose();
	};
}
