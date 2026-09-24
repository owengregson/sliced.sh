/**
 * tools/human-match/verification-audit/sample.ts — one deterministic position per fresh game.
 * The development/heldout split is by game hash, before any inference.
 */

import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import { clockCommentsMs } from "../../lib/pgn/export";

export interface AuditPosition {
	id: string;
	gameId: string;
	split: "development" | "heldout";
	bucket: number;
	selfElo: number;
	oppoElo: number;
	fen: string;
	historyFens: string[];
	humanMove: string;
}

/** One chess.com game of the source JSONL. */
export interface AuditGame {
	url: string;
	timeClass: string;
	whiteElo: number;
	blackElo: number;
	pgn: string;
}

export const AUDIT_BUCKETS = [900, 1400, 1900, 2400, 2700] as const;

export function hash(value: string): number {
	return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

/** One game is one independent unit, including across Elo buckets. */
export function samplePositions(
	games: AuditGame[],
	excluded: ReadonlySet<string>,
	perBucket: number
): AuditPosition[] {
	const used = new Set<string>();
	const positions: AuditPosition[] = [];
	const sorted = games
		.filter((g) => g.timeClass === "blitz")
		.sort((a, b) => hash(a.url) - hash(b.url));
	for (const bucket of AUDIT_BUCKETS) {
		let count = 0;
		for (const game of sorted) {
			if (count >= perBucket) break;
			const gameId = game.url.split("/").at(-1) ?? game.url;
			if (used.has(gameId) || excluded.has(gameId)) continue;
			const board = new Chess();
			try {
				board.loadPgn(game.pgn);
			} catch {
				continue;
			}
			const moves = board.history({ verbose: true });
			const clocks = clockCommentsMs(game.pgn);
			if (moves.length !== clocks.length) continue;
			const candidates = moves
				.map((m, ply) => ({ m, ply }))
				.filter(({ m, ply }) => {
					const rating = m.color === "w" ? game.whiteElo : game.blackElo;
					return (
						ply >= 16 &&
						ply < moves.length - 10 &&
						rating <= 2800 &&
						Math.abs(rating - bucket) <= 150 &&
						(clocks[ply - 2] ?? 0) >= 30000
					);
				});
			const selected = candidates[hash(`${gameId}:position`) % candidates.length];
			if (selected === undefined) continue;
			const { m, ply } = selected;
			if (new Chess(m.before).moves().length < 2) continue;
			positions.push({
				id: `${gameId}-${ply}`,
				gameId,
				bucket,
				split: hash(`${gameId}:split`) % 4 === 0 ? "development" : "heldout",
				selfElo: m.color === "w" ? game.whiteElo : game.blackElo,
				oppoElo: m.color === "w" ? game.blackElo : game.whiteElo,
				fen: m.before,
				historyFens: moves.slice(Math.max(0, ply - 7), ply + 1).map((move) => move.before),
				humanMove: m.from + m.to + (m.promotion ?? ""),
			});
			used.add(gameId);
			count++;
		}
	}
	return positions;
}
