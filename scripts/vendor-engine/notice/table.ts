// scripts/vendor-engine/notice/table.ts — the formatting every notice section shares.

import type { VendoredFile } from "../../lib/fs";

/** `1,234,567`: counts and byte sizes as the notice prints them. */
export const count = (n: number): string => n.toLocaleString("en-US");

/** One `| File | Bytes | SHA-256 |` row. */
export const fileRow = (f: VendoredFile): string =>
	`| \`${f.name}\` | ${count(f.bytes)} | \`${f.sha256}\` |`;

/** `max |Δprob| vs torch fp32`, or an em dash when the export recorded none. */
export const probDiff = (diff: number | undefined): string =>
	diff === undefined ? "—" : diff.toExponential(2);
