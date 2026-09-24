/**
 * tools/timing-finetune/dump-ts-inputs.ts — encode positions with the shipped TypeScript path so
 * the Python extractor can be compared with it byte for byte (`test_parity.py`).
 *
 *   bun tools/timing-finetune/dump-ts-inputs.ts <in.jsonl> <out.jsonl>
 *
 * Each input line: `{fen, moves, rating, playerClockS, opponentClockS, incrementS, baseSec, move?}`
 * (`move`: the timed move, which `buildInputs` puts last in the window).
 * Each output line: `buildInputs` (band, move tokens, FEN tokens, raw clocks) followed by
 * `standardiseInputs` for that band — exactly what the offscreen host feeds the ONNX session.
 */

import "../lib/defines";
import { readFileSync, writeFileSync } from "node:fs";
import { buildInputs } from "@core/timing/chessmimic-head/inputs";
import { standardiseInputs } from "@core/timing/chessmimic-scalers";
import type { TimingContext } from "@core/timing/types";

interface Row {
	fen: string;
	moves: string[];
	rating: number;
	playerClockS: number;
	opponentClockS: number;
	incrementS: number;
	baseSec: number;
	move?: string;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: dump-ts-inputs.ts <in.jsonl> <out.jsonl>");

const lines: string[] = [];
for (const line of readFileSync(input, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const row = JSON.parse(line) as Row;
	const ctx = {
		fen: row.fen,
		moves: row.moves,
		targetElo: row.rating,
		myClockMs: Math.round(row.playerClockS * 1000),
		oppClockMs: Math.round(row.opponentClockS * 1000),
		baseSec: row.baseSec,
		incSec: row.incrementS,
	} as unknown as TimingContext;
	const inputs = buildInputs(ctx, row.move);
	const std = standardiseInputs(inputs);
	lines.push(
		JSON.stringify({
			band: inputs.band,
			moveTokens: inputs.moveTokens,
			fenTokens: inputs.fenTokens,
			playerClockS: inputs.playerClockS,
			opponentClockS: inputs.opponentClockS,
			incrementS: inputs.incrementS,
			scaledRating: std.scaledRating,
			clockFeatures: std.clockFeatures,
		})
	);
}
writeFileSync(output, `${lines.join("\n")}\n`);
