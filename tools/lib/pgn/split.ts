/**
 * tools/lib/pgn/split.ts — cutting a multi-game PGN file into one text per game, for the tools
 * that hand each game to `chess.js`'s `loadPgn`. Two cuts exist and are not interchangeable:
 */

/**
 * One chunk per line-initial `[Event ` tag, line endings normalised to `\n`, untrimmed. On an
 * export whose every game opens with `[Event`, chunk `i` is game `i` of `parseGames` — the
 * alignment `tools/timing/build-pgn-corpus.ts` replays by.
 */
export function splitAtEventTags(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split(/(?=^\[Event )/m)
		.filter((s) => s.trim());
}

/** Games separated by a blank line before `[Event `, each trimmed, empty ones dropped. */
export function splitGamesTrimmed(text: string): string[] {
	return text
		.split(/\n\s*\n(?=\[Event )/)
		.map((game) => game.trim())
		.filter((game) => game.length > 0);
}
