/** Number and text formatting for the Engine view's rows and log panes. */

import type { LogEntry } from "@core/logger";
import { COPY } from "../../copy";

const MEGA = 1_000_000;
const KILO = 1_000;
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const TWO_DIGITS = 10;

/** `1.42 Mn/s`, `950 kn/s`, `420 n/s`; the em dash when unknown. */
export function formatNps(nps: number | undefined): string {
	if (nps === undefined || !Number.isFinite(nps)) return COPY.engineView.none;
	if (nps >= MEGA) return COPY.engineView.nps.mega((nps / MEGA).toFixed(2));
	if (nps >= KILO) return COPY.engineView.nps.kilo(String(Math.round(nps / KILO)));
	return COPY.engineView.nps.unit(String(Math.round(nps)));
}

export const seconds = (ms: number): string => (ms / SECOND_MS).toFixed(1);
export const signedSeconds = (ms: number): string =>
	`${ms >= 0 ? "+" : "−"}${seconds(Math.abs(ms))}`;

/** `m:ss` from a clock in ms (the 8ch column of the rationale log). */
export function clockText(ms: number): string {
	const total = Math.max(0, Math.round(ms / SECOND_MS));
	const m = Math.floor(total / (MINUTE_MS / SECOND_MS));
	const s = total % (MINUTE_MS / SECOND_MS);
	return `${m}:${s < TWO_DIGITS ? "0" : ""}${s}`;
}

export function nnueNames(names: readonly string[]): string {
	const short = names.map((n) => n.replace(/\.nnue$/, "")).filter(Boolean);
	return short.length > 0 ? short.join(" + ") : COPY.engine.rows.nnueLoaded;
}

export function timeOfDay(timestamp: number): string {
	const d = new Date(timestamp);
	const pad = (n: number): string => (n < TWO_DIGITS ? `0${n}` : String(n));
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function sourceLabel(source: string): string {
	try {
		const url = new URL(source);
		return url.pathname.split("/").pop() || url.host;
	} catch {
		return source;
	}
}

export function argText(arg: LogEntry["args"][number]): string {
	if (typeof arg === "string") return arg;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}
