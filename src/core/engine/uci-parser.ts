/**
 * UCI line parsers (Appendix A §6). Pure: tokenise on whitespace, walk the
 * keywords left to right; every value keyword consumes one token except
 * `score` (2–3), `wdl` (3) and `pv` / `string` (rest of line).
 */

import type { UciOptionSpec } from "./types";

export interface UciScore {
	type: "cp" | "mate";
	value: number;
	/** Fail-high / fail-low interim report. */
	bound?: "lower" | "upper";
}

export interface Info {
	depth?: number;
	seldepth?: number;
	multipv?: number;
	score?: UciScore;
	wdl?: [number, number, number];
	nodes?: number;
	nps?: number;
	hashfull?: number;
	tbhits?: number;
	time?: number;
	pv?: string[];
	currmove?: string;
	currmovenumber?: number;
	string?: string;
}

type NumericKey =
	| "depth"
	| "seldepth"
	| "multipv"
	| "nodes"
	| "nps"
	| "hashfull"
	| "tbhits"
	| "time"
	| "currmovenumber";

const NUMERIC_KEYS: ReadonlySet<string> = new Set<NumericKey>([
	"depth",
	"seldepth",
	"multipv",
	"nodes",
	"nps",
	"hashfull",
	"tbhits",
	"time",
	"currmovenumber",
]);

function isNumericKey(t: string): t is NumericKey {
	return NUMERIC_KEYS.has(t);
}

function tokenise(line: string): string[] {
	const trimmed = line.trim();
	return trimmed === "" ? [] : trimmed.split(/\s+/);
}

function int(t: string | undefined): number | undefined {
	if (t === undefined || !/^-?\d+$/.test(t)) return undefined;
	return Number(t);
}

export function parseInfo(line: string): Info | undefined {
	const t = tokenise(line);
	if (t[0] !== "info") return undefined;
	const o: Info = {};
	for (let i = 1; i < t.length; i++) {
		const key = t[i] as string;
		if (isNumericKey(key)) {
			const n = int(t[++i]);
			if (n !== undefined) o[key] = n;
			continue;
		}
		switch (key) {
			case "currmove": {
				const m = t[++i];
				if (m !== undefined) o.currmove = m;
				break;
			}
			case "score": {
				const type = t[++i];
				const value = int(t[++i]);
				if ((type !== "cp" && type !== "mate") || value === undefined) break;
				const score: UciScore = { type, value };
				const next = t[i + 1];
				if (next === "lowerbound" || next === "upperbound") {
					score.bound = next === "lowerbound" ? "lower" : "upper";
					i++;
				}
				o.score = score;
				break;
			}
			case "wdl": {
				const w = int(t[++i]);
				const d = int(t[++i]);
				const l = int(t[++i]);
				if (w !== undefined && d !== undefined && l !== undefined) o.wdl = [w, d, l];
				break;
			}
			case "pv":
				o.pv = t.slice(i + 1);
				i = t.length;
				break;
			case "string":
				o.string = t.slice(i + 1).join(" ");
				i = t.length;
				break;
			case "refutation":
			case "currline":
				i = t.length;
				break;
			default:
				break;
		}
	}
	return o;
}

/**
 * lichess behaviour: a `lowerbound`/`upperbound` report on the primary line is
 * a fail-high/low interim and is ignored; on multipv > 1 it is accepted.
 */
export function isInterimBoundLine(info: Info): boolean {
	return info.score?.bound !== undefined && (info.multipv ?? 1) === 1;
}

export interface Bestmove {
	/** `null` for `bestmove (none)`. */
	bestmove: string | null;
	ponder?: string;
}

export function parseBestmove(line: string): Bestmove | undefined {
	const t = tokenise(line);
	if (t[0] !== "bestmove") return undefined;
	const move = t[1];
	if (move === undefined) return undefined;
	const out: Bestmove = { bestmove: move === "(none)" ? null : move };
	const pi = t.indexOf("ponder");
	const ponder = pi > 0 ? t[pi + 1] : undefined;
	if (ponder !== undefined) out.ponder = ponder;
	return out;
}

const OPTION_TYPES: ReadonlySet<string> = new Set(["check", "spin", "combo", "button", "string"]);
const OPTION_KEYWORDS: ReadonlySet<string> = new Set(["default", "min", "max", "var"]);

function isOptionType(t: string | undefined): t is UciOptionSpec["type"] {
	return t !== undefined && OPTION_TYPES.has(t);
}

/** `option name <Name…> type <type> [default <v…>] [min <n>] [max <n>] [var <x>]*` */
export function parseOption(line: string): { name: string; spec: UciOptionSpec } | undefined {
	const t = tokenise(line);
	if (t[0] !== "option" || t[1] !== "name") return undefined;
	const typeAt = t.indexOf("type", 2);
	if (typeAt < 3) return undefined;
	const type = t[typeAt + 1];
	if (!isOptionType(type)) return undefined;
	const name = t.slice(2, typeAt).join(" ");
	const spec: UciOptionSpec = { type };
	for (let i = typeAt + 2; i < t.length; i++) {
		const key = t[i];
		if (key === "default") {
			let j = i + 1;
			while (j < t.length && !OPTION_KEYWORDS.has(t[j] as string)) j++;
			spec.default = t.slice(i + 1, j).join(" ");
			i = j - 1;
		} else if (key === "min" || key === "max") {
			const n = int(t[++i]);
			if (n !== undefined) spec[key] = n;
		} else if (key === "var") {
			const v = t[++i];
			if (v !== undefined) {
				spec.vars ??= [];
				spec.vars.push(v);
			}
		}
	}
	return { name, spec };
}

/** `id name Stockfish 18` / `id author …` */
export function parseId(line: string): { key: "name" | "author"; value: string } | undefined {
	const t = tokenise(line);
	if (t[0] !== "id") return undefined;
	const key = t[1];
	if (key !== "name" && key !== "author") return undefined;
	return { key, value: t.slice(2).join(" ") };
}
