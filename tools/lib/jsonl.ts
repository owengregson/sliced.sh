/**
 * tools/lib/jsonl.ts — JSON Lines in and out, for the corpora and caches the research tools stream:
 * an async line reader over a `Bun.file` stream, a synchronous chunked reader for files that can
 * be gigabytes (and may end in a torn line), and a buffered writer.
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";

/**
 * Read a JSONL file line by line without holding the text twice. Blank lines are skipped; with
 * `tolerant` an unparsable line is skipped too, otherwise it throws.
 */
export async function* readJsonl<T>(file: string, tolerant = false): AsyncGenerator<T> {
	const parse = (line: string): T | undefined => {
		if (!tolerant) return JSON.parse(line) as T;
		try {
			return JSON.parse(line) as T;
		} catch {
			return undefined;
		}
	};
	const reader = Bun.file(file).stream().pipeThrough(new TextDecoderStream()).getReader();
	let rest = "";
	for (;;) {
		const { value: chunk, done } = await reader.read();
		if (done) break;
		rest += chunk;
		let nl = rest.indexOf("\n");
		while (nl >= 0) {
			const line = rest.slice(0, nl);
			rest = rest.slice(nl + 1);
			const v = line.trim() ? parse(line) : undefined;
			if (v !== undefined) yield v;
			nl = rest.indexOf("\n");
		}
	}
	const last = rest.trim() ? parse(rest) : undefined;
	if (last !== undefined) yield last;
}

/**
 * Parsed lines of a JSONL file, read synchronously in 8 MB chunks (the file can be gigabytes). A
 * missing file yields nothing; blank and unparsable (torn) lines are skipped.
 */
export function* readJsonlSync<T>(file: string): Generator<T> {
	if (!existsSync(file)) return;
	const fd = openSync(file, "r");
	const buf = Buffer.alloc(8 << 20);
	const decoder = new TextDecoder();
	let carry = "";
	try {
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			const text = carry + (n > 0 ? decoder.decode(buf.subarray(0, n), { stream: true }) : "");
			const lines = text.split("\n");
			carry = n > 0 ? (lines.pop() ?? "") : "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					yield JSON.parse(line) as T;
				} catch {
					// a torn line; skipped
				}
			}
			if (n <= 0) break;
		}
	} finally {
		closeSync(fd);
	}
}

/** A buffered JSONL writer. */
export class JsonlWriter {
	private readonly sink: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
	constructor(file: string) {
		this.sink = Bun.file(file).writer();
	}
	write(value: unknown): void {
		this.sink.write(`${JSON.stringify(value)}\n`);
	}
	async close(): Promise<void> {
		await this.sink.end();
	}
}
