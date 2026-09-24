/**
 * tools/lib/jsonl.ts — reading JSONL files the size the research data reaches (GB): a streaming
 * line reader, a whole-file reader for small inputs, and the leading-id peek the calibration
 * joins use to skip a record without parsing it.
 */

import { existsSync, readFileSync } from "node:fs";

/** Line-by-line over a (possibly large) JSONL file without holding it as one string. */
export async function* jsonlLines(file: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = Bun.file(file).stream().getReader();
	let rest = "";
	for (;;) {
		const { done, value } = await reader.read();
		rest += done ? decoder.decode() : decoder.decode(value, { stream: true });
		let start = 0;
		let nl = rest.indexOf("\n", start);
		while (nl >= 0) {
			const line = rest.slice(start, nl).trim();
			if (line) yield line;
			start = nl + 1;
			nl = rest.indexOf("\n", start);
		}
		rest = rest.slice(start);
		if (done) break;
	}
	if (rest.trim()) yield rest.trim();
}

/** Every record of a small JSONL file (blank lines skipped); throws `missing <file>` when absent. */
export function readJsonl<T>(file: string): T[] {
	if (!existsSync(file)) throw new Error(`missing ${file}`);
	const out: T[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim()) out.push(JSON.parse(line) as T);
	}
	return out;
}

/** The `id` of a record that **starts** with `{"id":"…"`, without parsing the line; else null. */
export function headId(line: string): string | null {
	const m = /^\{"id":("(?:[^"\\]|\\.)*")/.exec(line);
	return m?.[1] ? (JSON.parse(m[1]) as string) : null;
}
