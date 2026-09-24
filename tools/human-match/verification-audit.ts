/**
 * Paired verification audit on fresh human games, with immutable captured model/search inputs.
 * bun tools/human-match/verification-audit.ts GAMES.jsonl CACHE_DIR [perBucket=60]
 * Uses one deterministic position per game; excludes games in the earlier strength tuning store.
 * Development/heldout split is by game hash, before inference. No parameter fitting occurs here.
 * The stages live in `verification-audit/`: sampling, capture, the laws and the report.
 */
import "./defines";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { type CapturedRecord, captureMissing, recordFile } from "./verification-audit/capture";
import { auditRow, auditSummary } from "./verification-audit/report";
import { type AuditGame, samplePositions } from "./verification-audit/sample";

export { legacyDistribution } from "./verification-audit/laws";
export { type AuditPosition, samplePositions } from "./verification-audit/sample";

async function main() {
	const [source, cache, perBucketText] = process.argv.slice(2);
	if (!source || !cache) throw new Error("Expected GAMES.jsonl CACHE_DIR [perBucket=60]");
	await mkdir(cache, { recursive: true });
	const games = (await Bun.file(source).text())
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as AuditGame);
	const oldStore = path.resolve(".scratch/bot-strength/store");
	const excluded = new Set(
		(await readdir(oldStore).catch(() => [] as string[])).map((f) => f.split("_")[1] ?? "")
	);
	const positions = samplePositions(games, excluded, Number(perBucketText ?? 60));
	const sourceSha256 = createHash("sha256")
		.update(new Uint8Array(await Bun.file(source).arrayBuffer()))
		.digest("hex");
	await Bun.write(
		path.join(cache, "sample.json"),
		JSON.stringify({ sourceSha256, excludedGames: excluded.size, positions }, null, 2)
	);
	await captureMissing(positions, cache);
	const rows = [];
	for (const position of positions) {
		const record = (await Bun.file(recordFile(cache, position)).json()) as CapturedRecord;
		if (JSON.stringify(record.position) !== JSON.stringify(position))
			throw new Error(`${position.id}: cached model inputs differ; use a fresh cache directory`);
		rows.push(auditRow(record));
	}
	const summary = auditSummary(rows);
	const report = {
		sourceSha256,
		excludedGames: excluded.size,
		sampleCount: positions.length,
		note:
			"Isolated verifier audit, all legal Maia moves; excludes book, rails, timing, platform rating conversion and runtime root truncation. SF19 full net. No parameter fitting.",
		summary,
		rows,
	};
	await Bun.write(path.join(cache, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) await main();
