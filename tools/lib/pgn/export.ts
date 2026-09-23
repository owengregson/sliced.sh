/**
 * tools/lib/pgn/export.ts — reading a chess.com PGN export: games, headers, `[%clk]` readings and
 * the `TimeControl` tag. No chess rules; `chess.js` replays the moves where a tool needs them.
 *
 * Parsing notes (learned the hard way):
 *   - headers end at the game's **first blank line**; the movetext contains `]` inside every
 *     `{[%clk …]}` comment, so never scan backwards for the last `]`;
 *   - the n-th `[%clk]` comment is the clock **after** ply n (0-based, even = White).
 */

/** One parsed game: the headers plus the per-ply clock readings, in ply order. */
export interface ParsedGame {
	headers: Record<string, string>;
	/** Seconds left on the mover's clock after ply i (0-based, even = White). */
	clocksAfterPly: number[];
}

/** `0:02:59.9` → 179.9 */
export function parseClock(text: string): number {
	const parts = text.split(":").map((p) => Number(p));
	if (parts.some((p) => !Number.isFinite(p))) return Number.NaN;
	let seconds = 0;
	for (const p of parts) seconds = seconds * 60 + (p ?? 0);
	return seconds;
}

const HEADER_RE = /^\[([A-Za-z0-9_]+)\s+"(.*)"\]\s*$/;
const CLK_RE = /\{\s*\[%clk\s+([0-9:.]+)\s*\]\s*\}/g;

/**
 * Every game in a PGN export. A game is a run of `[Tag "…"]` lines, the **first blank line**, then
 * the movetext up to the next blank line that is followed by another tag line (or EOF).
 */
export function parseGames(pgn: string): ParsedGame[] {
	const lines = pgn.replace(/\r\n?/g, "\n").split("\n");
	const games: ParsedGame[] = [];
	let headers: Record<string, string> | null = null;
	let movetext: string[] = [];
	const flush = (): void => {
		if (!headers) return;
		const text = movetext.join(" ");
		const clocks: number[] = [];
		CLK_RE.lastIndex = 0;
		for (let m = CLK_RE.exec(text); m; m = CLK_RE.exec(text)) clocks.push(parseClock(m[1] ?? ""));
		games.push({ headers, clocksAfterPly: clocks });
		headers = null;
		movetext = [];
	};
	for (const raw of lines) {
		const line = raw.trim();
		const header = HEADER_RE.exec(line);
		if (header) {
			// a tag line after movetext opens the next game
			if (movetext.length > 0) flush();
			headers ??= {};
			headers[header[1] ?? ""] = header[2] ?? "";
			continue;
		}
		if (line === "") continue; // the header/movetext separator, and the gap between games
		if (headers) movetext.push(line);
	}
	flush();
	return games;
}

/** `"180"` → `{ baseSec: 180, incSec: 0 }`; `"180+2"` → `{ baseSec: 180, incSec: 2 }`. */
export function parseTimeControl(tc: string): { baseSec: number; incSec: number } | null {
	const m = /^(\d+)(?:\+(\d+))?$/.exec(tc.trim());
	if (!m) return null;
	return { baseSec: Number(m[1]), incSec: Number(m[2] ?? 0) };
}

/**
 * Every `[%clk h:mm:ss(.s)]` of a game's text in milliseconds, in order — the bare comment,
 * braces or not, with all three fields required (the chess.com API games' form).
 */
export function clockCommentsMs(pgn: string): number[] {
	return [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map(
		(m) => (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
	);
}

/** A numeric header tag (`[WhiteElo "1520"]` → 1520), read from a single game's text. */
export function numericTag(pgn: string, tag: string): number | undefined {
	const value = new RegExp(`\\[${tag} "(\\d+)"\\]`).exec(pgn)?.[1];
	return value === undefined ? undefined : Number(value);
}
