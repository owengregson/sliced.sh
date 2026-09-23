/**
 * The timing rationale log pane: the entries it holds (newest at the bottom, capped at
 * `LIMITS.timingLogMax`, one per game ply) and their rendered rows.
 */

import { LIMITS } from "@core/constants/limits";
import type { TimingLogEntry } from "@typedefs/timing";
import { COPY } from "../../copy";
import { instantiate, part } from "../../template";
import logLineHtml from "../templates/engine-log-line.html?raw";
import logRowHtml from "../templates/engine-log-row.html?raw";
import { rationaleRows } from "./rationale";

export interface TimingLogParts {
	rows: HTMLElement;
	pane: HTMLElement;
	empty: HTMLElement;
}

export interface TimingLogPane {
	readonly entries: readonly TimingLogEntry[];
	/** Drop every entry; a backlog that arrives afterwards is ignored. */
	clear(): void;
	/** A live entry: replaces the row for its game ply, or appends (trimming to the cap). */
	push(entry: TimingLogEntry): void;
	/** The service worker's stored log, merged under the entries already shown. */
	loadBacklog(entries: TimingLogEntry[]): void;
}

export function createTimingLog(parts: TimingLogParts): TimingLogPane {
	const { rows: logRows, pane: logPane, empty: logEmpty } = parts;
	let timingEntries: TimingLogEntry[] = [];
	let timingCleared = false;

	function appendRationale(entry: TimingLogEntry): void {
		for (const row of rationaleRows(entry)) {
			const rowEl = instantiate(logRowHtml);
			rowEl.dataset.kind = row.kind;
			part(rowEl, ".sl-engine__log-time").textContent = row.time;
			part(rowEl, ".sl-engine__log-kind").textContent = COPY.engine.logKinds[row.kind];
			const lines = part(rowEl, ".sl-engine__log-lines");
			for (const text of row.lines) {
				const line = instantiate(logLineHtml);
				line.textContent = text;
				lines.append(line);
			}
			logRows.append(rowEl);
		}
	}

	function renderTimingLog(): void {
		logRows.replaceChildren();
		for (const entry of timingEntries) appendRationale(entry);
		logEmpty.hidden = timingEntries.length > 0;
		logPane.scrollTop = logPane.scrollHeight;
	}

	return {
		get entries() {
			return timingEntries;
		},
		clear() {
			timingEntries = [];
			timingCleared = true;
			renderTimingLog();
		},
		push(entry) {
			const existing = timingEntries.findIndex(
				(row) => row.gameId === entry.gameId && row.ply === entry.ply
			);
			if (existing >= 0) {
				timingEntries[existing] = entry;
				renderTimingLog();
				return;
			}
			timingEntries.push(entry);
			if (timingEntries.length > LIMITS.timingLogMax) {
				timingEntries = timingEntries.slice(timingEntries.length - LIMITS.timingLogMax);
				renderTimingLog();
				return;
			}
			appendRationale(entry);
			logEmpty.hidden = true;
			logPane.scrollTop = logPane.scrollHeight;
		},
		loadBacklog(entries) {
			if (timingCleared || !Array.isArray(entries)) return;
			const merged = new Map<string, TimingLogEntry>();
			for (const entry of [...entries, ...timingEntries])
				merged.set(`${entry.gameId}:${entry.ply}`, entry);
			timingEntries = [...merged.values()].slice(-LIMITS.timingLogMax);
			renderTimingLog();
		},
	};
}
