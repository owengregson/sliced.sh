/**
 * tools/calibration/build-corpus.ts — turn the crawled chess.com games into per-move rows.
 *
 *     bun tools/calibration/build-corpus.ts
 *     bun tools/calibration/build-corpus.ts --games FILE --samples FILE --out FILE --summary FILE
 *
 * Reads `data/calibration/games.jsonl` and `samples.jsonl` (written by `crawl-chesscom.ts`) and
 * writes `corpus.jsonl`: one row per own move of every sampled (game, side), for plies ≥ 16 (the
 * product plays book moves in the opening) and positions with at least two legal moves. The row
 * is a superset of `CorpusRow` in `tools/human-match/replay.ts` (same field names), so the replay
 * can read it directly. `corpus-summary.json` holds the sides / positions table per
 * (time class, bucket, split).
 *
 * Clock notes (chess.com PGN): the n-th `[%clk]` is the mover's clock **after** ply n; the clock
 * runs from the first move, so a side's first think is `base − clk + inc`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { MAIA_INPUT } from "../../src/core/constants/maia";
import { PATHS, parseTimeControl, type Sample, type StoredGame, type TimeClass } from "./common";

/** Own moves are skipped before this ply (half-moves played before the position). */
export const MIN_PLY = 16;

export type Split = "fit" | "holdout";

export interface CalibrationRow {
	id: string;
	gameId: string;
	ply: number;
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	humanMove: string;
	clockMs: number;
	oppClockMs: number;
	baseMs: number;
	incrementMs: number;
	lastMove: string;
	prevOwnMove: string;
	thinkMs: number;
	tc: TimeClass;
	bucket: number;
	player: string;
	color: "w" | "b";
	split: Split;
	/** 1-based index of this move among the side's own moves (ply 16 by White is move 9). */
	moveNumberInGame: number;
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

/** The fit/holdout split, by player: first byte of sha1(`calib:${player}`) < 154 → fit (≈ 60 %). */
export function splitFor(player: string): Split {
	const first = createHash("sha1").update(`calib:${player.toLowerCase()}`).digest()[0] ?? 0;
	return first < 154 ? "fit" : "holdout";
}

/** `"0:02:59.9"` / `"2:59"` / `"59.3"` → milliseconds, or null when unreadable. */
export function parseClockMs(text: string): number | null {
	const parts = text.trim().split(":");
	if (parts.length === 0 || parts.length > 3) return null;
	let seconds = 0;
	for (const p of parts) {
		if (!/^\d+(?:\.\d+)?$/.test(p)) return null;
		seconds = seconds * 60 + Number(p);
	}
	return Math.round(seconds * 1000);
}

/** A chess.js move → UCI, promotion as a lowercase suffix. */
export function toUci(move: { from: string; to: string; promotion?: string | undefined }): string {
	return `${move.from}${move.to}${move.promotion ? move.promotion.toLowerCase() : ""}`;
}

export interface ParsedPgn {
	headers: Record<string, string>;
	/** SAN per ply. */
	sans: string[];
	/** Clock after each ply (ms), null where the ply carried no `[%clk]`. */
	clocksMs: Array<number | null>;
}

/** Headers, SAN moves and per-ply clocks. Variations `( … )` and NAGs are skipped. */
export function parsePgn(pgn: string): ParsedPgn {
	const headers: Record<string, string> = {};
	const lines = pgn.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	for (; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line === "") {
			if (Object.keys(headers).length > 0) break;
			continue;
		}
		const m = /^\[(\w+)\s+"(.*)"\]$/.exec(line);
		if (!m) break;
		headers[m[1] as string] = (m[2] as string).replace(/\\"/g, '"');
	}
	const movetext = lines.slice(i).join(" ");
	const sans: string[] = [];
	const clocksMs: Array<number | null> = [];
	const token =
		/\{([^}]*)\}|\(|\)|;[^\n]*|\$\d+|(\d+)\.(?:\.\.)?|(1-0|0-1|1\/2-1\/2|\*)|([^\s{}()]+)/g;
	let depth = 0;
	for (let m = token.exec(movetext); m !== null; m = token.exec(movetext)) {
		const whole = m[0];
		if (whole === "(") {
			depth++;
			continue;
		}
		if (whole === ")") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (depth > 0) continue;
		if (m[1] !== undefined) {
			const clk = /\[%clk\s+([\d:.]+)\]/.exec(m[1]);
			if (clk?.[1] && clocksMs.length > 0 && clocksMs[clocksMs.length - 1] === null) {
				clocksMs[clocksMs.length - 1] = parseClockMs(clk[1]);
			}
			continue;
		}
		if (m[2] !== undefined || m[3] !== undefined || whole.startsWith(";") || whole.startsWith("$"))
			continue;
		if (m[4] !== undefined) {
			const san = m[4].replace(/[!?]+$/, "");
			if (san === "") continue;
			sans.push(san);
			clocksMs.push(null);
		}
	}
	return { headers, sans, clocksMs };
}

export interface ReplayedGame {
	/** FEN before each ply, plus the final position (length = plies + 1). */
	fens: string[];
	/** UCI per ply. */
	ucis: string[];
	/** Legal move count before each ply. */
	legalCounts: number[];
}

/** Replay SAN moves from the start position; throws on an illegal move. */
export function replaySans(sans: readonly string[]): ReplayedGame {
	const board = new Chess();
	const fens = [board.fen()];
	const ucis: string[] = [];
	const legalCounts: number[] = [];
	for (const san of sans) {
		legalCounts.push(board.moves().length);
		const move = board.move(san);
		ucis.push(toUci(move));
		fens.push(board.fen());
	}
	return { fens, ucis, legalCounts };
}

/** The last ≤ `MAIA_INPUT.history` positions oldest → newest ending with the position before `ply`. */
export function historyWindow(fens: readonly string[], ply: number): string[] {
	return fens.slice(Math.max(0, ply + 1 - MAIA_INPUT.history), ply + 1);
}

export interface SampleContext {
	uuid: string;
	side: "w" | "b";
	tc: TimeClass;
	bucket: number;
	player: string;
	selfElo: number;
	oppoElo: number;
	timeControl: string;
}

/** All corpus rows for one sampled side of one game; empty when the PGN does not replay. */
export function rowsForSample(pgn: string, ctx: SampleContext): CalibrationRow[] {
	const tcParsed = parseTimeControl(ctx.timeControl);
	if (!tcParsed) return [];
	const baseMs = Math.round(tcParsed.baseS * 1000);
	const incrementMs = Math.round(tcParsed.incS * 1000);
	const parsed = parsePgn(pgn);
	let game: ReplayedGame;
	try {
		game = replaySans(parsed.sans);
	} catch {
		return [];
	}
	const clocks = parsed.clocksMs;
	const clockAfter = (ply: number): number | null => (ply < 0 ? baseMs : (clocks[ply] ?? null));
	const own = ctx.side === "w" ? 0 : 1;
	const split = splitFor(ctx.player);
	const rows: CalibrationRow[] = [];
	for (let ply = own; ply < game.ucis.length; ply += 2) {
		if (ply < MIN_PLY) continue;
		if ((game.legalCounts[ply] ?? 0) < 2) continue;
		const clockMs = clockAfter(ply - 2);
		const oppClockMs = clockAfter(ply - 1);
		const nowMs = clockAfter(ply);
		if (clockMs === null || oppClockMs === null || nowMs === null) continue;
		const fen = game.fens[ply] as string;
		rows.push({
			id: `${ctx.uuid}:${ply}`,
			gameId: ctx.uuid,
			ply,
			fen,
			historyFens: historyWindow(game.fens, ply),
			selfElo: ctx.selfElo,
			oppoElo: ctx.oppoElo,
			humanMove: game.ucis[ply] as string,
			clockMs,
			oppClockMs,
			baseMs,
			incrementMs,
			lastMove: game.ucis[ply - 1] as string,
			prevOwnMove: game.ucis[ply - 2] as string,
			thinkMs: clockMs - nowMs + incrementMs,
			tc: ctx.tc,
			bucket: ctx.bucket,
			player: ctx.player,
			color: ctx.side,
			split,
			moveNumberInGame: Math.floor(ply / 2) + 1,
		});
	}
	return rows;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

function readJsonl<T>(file: string): T[] {
	if (!existsSync(file)) throw new Error(`missing ${file}`);
	const out: T[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim()) out.push(JSON.parse(line) as T);
	}
	return out;
}

/** A contiguous run of `n` rows starting at a position fixed by `key` (all rows when fewer). */
export function windowOf<T>(rows: readonly T[], n: number, key: string): T[] {
	if (rows.length <= n) return [...rows];
	const digest = createHash("sha1").update(`window:${key}`).digest();
	const start = digest.readUInt32BE(0) % (rows.length - n + 1);
	return rows.slice(start, start + n);
}

interface SummaryCell {
	tc: TimeClass;
	bucket: number;
	split: Split;
	sides: number;
	positions: number;
}

function main(): void {
	const argv = process.argv.slice(2);
	const opt = (name: string, fallback: string): string => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
	};
	const gamesFile = opt("--games", PATHS.games);
	const samplesFile = opt("--samples", PATHS.samples);
	const outFile = opt("--out", PATHS.corpus);
	const summaryFile = opt("--summary", PATHS.corpusSummary);
	// Samples listed in `--full` keep every own move; the rest keep a contiguous window of
	// `--window` own moves (0 = all), so more games fit the same engine budget — between-game
	// variation dominates the calibration's uncertainty, so games are worth more than moves.
	const window = Number(opt("--window", "0"));
	const fullFile = opt("--full", "");
	const full = new Set(
		fullFile ? readJsonl<Sample>(fullFile).map((s) => `${s.uuid}:${s.side}`) : []
	);

	const games = new Map<string, StoredGame>();
	for (const g of readJsonl<StoredGame>(gamesFile)) games.set(g.uuid, g);
	const samples = readJsonl<Sample>(samplesFile);

	const cells = new Map<string, SummaryCell>();
	const chunks: string[] = [];
	let missing = 0;
	let unreplayable = 0;
	let rowsTotal = 0;
	for (const s of samples) {
		const g = games.get(s.uuid);
		if (!g) {
			missing++;
			continue;
		}
		const self = s.side === "w" ? g.white : g.black;
		const opp = s.side === "w" ? g.black : g.white;
		const allRows = rowsForSample(g.pgn, {
			uuid: s.uuid,
			side: s.side,
			tc: s.tc,
			bucket: s.bucket,
			player: s.player,
			selfElo: self.rating,
			oppoElo: opp.rating,
			timeControl: g.time_control,
		});
		const rows =
			window > 0 && !full.has(`${s.uuid}:${s.side}`)
				? windowOf(allRows, window, `${s.uuid}:${s.side}`)
				: allRows;
		if (rows.length === 0) {
			unreplayable++;
			continue;
		}
		const split = splitFor(s.player);
		const key = `${s.tc}:${s.bucket}:${split}`;
		const cell = cells.get(key) ?? { tc: s.tc, bucket: s.bucket, split, sides: 0, positions: 0 };
		cell.sides++;
		cell.positions += rows.length;
		cells.set(key, cell);
		for (const r of rows) chunks.push(JSON.stringify(r));
		rowsTotal += rows.length;
	}
	writeFileSync(outFile, chunks.length > 0 ? `${chunks.join("\n")}\n` : "");

	const table = [...cells.values()].sort(
		(a, b) => a.tc.localeCompare(b.tc) || a.bucket - b.bucket || a.split.localeCompare(b.split)
	);
	writeFileSync(
		summaryFile,
		`${JSON.stringify({ rows: rowsTotal, samples: samples.length, missing, unreplayable, cells: table }, null, "\t")}\n`
	);

	console.log(
		`${rowsTotal} rows from ${samples.length} samples (${missing} missing games, ${unreplayable} with no rows)`
	);
	console.log("tc      bucket   fit sides/pos     holdout sides/pos");
	const tcs = [...new Set(table.map((c) => c.tc))];
	for (const tc of tcs) {
		const buckets = [...new Set(table.filter((c) => c.tc === tc).map((c) => c.bucket))];
		for (const b of buckets) {
			const f = cells.get(`${tc}:${b}:fit`);
			const h = cells.get(`${tc}:${b}:holdout`);
			const fmt = (c: SummaryCell | undefined): string =>
				`${String(c?.sides ?? 0).padStart(5)} / ${String(c?.positions ?? 0).padEnd(7)}`;
			console.log(`${tc.padEnd(7)} ${String(b).padStart(6)}   ${fmt(f)}   ${fmt(h)}`);
		}
	}
}

if (import.meta.main) {
	main();
}
