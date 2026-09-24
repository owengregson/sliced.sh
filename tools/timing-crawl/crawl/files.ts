/**
 * tools/timing-crawl/crawl/files.ts — the crash-safe file mechanics: an atomic replace for the
 * snapshots and a torn-tail trim for the append-only JSONL files (kill -9 mid-append).
 */

import {
	closeSync,
	existsSync,
	ftruncateSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";

export function atomicWrite(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Drop a torn last line (a crash mid-append) so the next append starts on a fresh line. */
export function dropTornTail(file: string): void {
	if (!existsSync(file)) return;
	const size = statSync(file).size;
	if (size === 0) return;
	const fd = openSync(file, "r+");
	try {
		const chunk = 1 << 20;
		let end = size;
		const buf = Buffer.alloc(chunk);
		readSync(fd, buf, 0, 1, size - 1);
		if (buf[0] === 0x0a) return;
		while (end > 0) {
			const start = Math.max(0, end - chunk);
			const n = readSync(fd, buf, 0, end - start, start);
			const i = buf.subarray(0, n).lastIndexOf(0x0a);
			if (i >= 0) {
				ftruncateSync(fd, start + i + 1);
				return;
			}
			end = start;
		}
		ftruncateSync(fd, 0);
	} finally {
		closeSync(fd);
	}
}
