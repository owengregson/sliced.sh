/**
 * tools/pgn-clock-reference.ts — the human blitz clock reference
 * (`test/fixtures/timing/human-blitz-clock.json`), extracted from a chess.com PGN export.
 *
 * The measurement behind `docs/research/chessmimic-bands-and-the-clock-2026-09-13.md` §2: in the
 * owner's own 3+0 games at ~2400, the **human opponent of each game** is the control — the same
 * position, the same clock, a real player of our own rating. This script turns that export into
 * the aggregate table `test/core/timing/blitz-clock-budget.test.ts` asserts against, so the tests
 * carry a measured target rather than a hand-set one.
 *
 *     bun tools/pgn-clock-reference.ts --pgn "chess_com_games_2026-09-13 (1).pgn"
 *     bun tools/pgn-clock-reference.ts --pgn FILE --out test/fixtures/timing/human-blitz-clock.json
 *     bun tools/pgn-clock-reference.ts --pgn FILE --print      # table only, writes nothing
 *
 * The PGN itself is personal game data and is **not** checked in; only the derived aggregate is.
 * Nothing here runs in the extension or in `bun run check`.
 *
 * Parsing notes (learned the hard way):
 *   - headers end at the game's **first blank line**; the movetext contains `]` inside every
 *     `{[%clk …]}` comment, so never scan backwards for the last `]`;
 *   - the n-th `[%clk]` comment is the clock **after** ply n (0-based, even = White), so
 *     `think = clk_prev − clk_now + inc` with `clk_prev` = the base clock for a side's first move;
 *   - the clock fraction a think is bucketed by is `clk_prev / base` — what that player had on
 *     their own clock *before* the move.
 */

import path from "node:path";

/** One parsed game: the headers plus the per-ply clock readings, in ply order. */
export interface ParsedGame {
	headers: Record<string, string>;
	/** Seconds left on the mover's clock after ply i (0-based, even = White). */
	clocksAfterPly: number[];
}

/** One think, already attributed to a side. */
export interface Think {
	/** Our move number for this side (1-based). */
	moveNo: number;
	/** Seconds spent. */
	thinkS: number;
	/** Seconds on this player's own clock before the move. */
	clockBeforeS: number;
	/** Seconds on this player's own clock after the move. */
	clockAfterS: number;
	/** `clockBeforeS / base`. */
	fraction: number;
}

export interface BucketSpec {
	label: string;
	/** Inclusive upper edge of the fraction (the first bucket's upper edge is 1, the start). */
	from: number;
	/** Exclusive lower edge of the fraction (the last bucket's is 0). */
	to: number;
}

/** The §2.2 buckets: the fraction of the starting clock still on that player's own clock. */
export const BUCKETS: readonly BucketSpec[] = [
	{ label: "1.00-0.85", from: 1, to: 0.85 },
	{ label: "0.85-0.55", from: 0.85, to: 0.55 },
	{ label: "0.55-0.25", from: 0.55, to: 0.25 },
	{ label: "0.25-0.00", from: 0.25, to: 0 },
] as const;

export interface BucketStats {
	n: number;
	meanS: number;
	medianS: number;
	shareUnder1s: number;
	shareUnder2s: number;
	shareOver10s: number;
	/** p5, p10, p20 … p90, p95 in seconds — the shape, not just the level. */
	percentiles: Record<string, number>;
}

const PERCENTILES = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95] as const;
/** Our clock left after these move numbers (§2.1). */
const CLOCK_MILESTONES = [10, 15, 20, 30, 40, 50] as const;

// ---------------------------------------------------------------------------- parsing

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
 * The thinks of one side of one game. `side` is 0 for White, 1 for Black; `clk_prev` starts at the
 * base clock and every later move reads that side's own previous `[%clk]`.
 */
export function thinksOf(game: ParsedGame, side: 0 | 1, baseSec: number, incSec: number): Think[] {
	const out: Think[] = [];
	let previous = baseSec;
	let moveNo = 0;
	for (let ply = side; ply < game.clocksAfterPly.length; ply += 2) {
		const now = game.clocksAfterPly[ply];
		if (now === undefined || !Number.isFinite(now)) break;
		moveNo += 1;
		const thinkS = previous - now + incSec;
		// A negative think means added time (`moretime`) or a clock oddity — drop the row, but keep
		// the clock reading so the rest of the game stays attributed correctly.
		if (thinkS >= 0)
			out.push({
				moveNo,
				thinkS: Number(thinkS.toFixed(3)),
				clockBeforeS: previous,
				clockAfterS: now,
				fraction: previous / baseSec,
			});
		previous = now;
	}
	return out;
}

// ---------------------------------------------------------------------------- statistics

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	if (sorted.length === 1) return sorted[0] ?? Number.NaN;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	const a = sorted[lo] ?? 0;
	const b = sorted[hi] ?? 0;
	return a + (b - a) * (rank - lo);
}

const round = (x: number, places: number): number =>
	Number.isFinite(x) ? Number(x.toFixed(places)) : x;

/**
 * The bucket a clock fraction falls in. Both edges are inclusive and the buckets are tried from
 * the top, so a think made with exactly 0.55 of the base clock is the *slow* end of `0.85-0.55`
 * rather than the fast end of `0.55-0.25` — the convention the §2.2 table was measured with
 * (it is worth one row per side in this corpus).
 */
export function bucketOf(fraction: number): string | null {
	for (const b of BUCKETS) if (fraction <= b.from && fraction >= b.to) return b.label;
	return null;
}

export function statsOf(values: number[]): BucketStats {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const share = (predicate: (x: number) => boolean): number =>
		n === 0 ? Number.NaN : round(sorted.filter(predicate).length / n, 4);
	const percentiles: Record<string, number> = {};
	for (const p of PERCENTILES) percentiles[`p${p}`] = round(percentile(sorted, p), 2);
	return {
		n,
		meanS: round(n === 0 ? Number.NaN : sorted.reduce((a, b) => a + b, 0) / n, 2),
		medianS: round(percentile(sorted, 50), 2),
		shareUnder1s: share((x) => x < 1),
		shareUnder2s: share((x) => x < 2),
		shareOver10s: share((x) => x > 10),
		percentiles,
	};
}

/** Every think of the side, pooled. */
export const OVERALL = "overall";
/**
 * The two middle buckets together — the part of the game the long-think share is asserted over.
 * Pooling the *whole* game there is misleading: a simulated game keeps playing on a nearly empty
 * clock long after a real one has ended, and the sub-second moves that adds swamp the share.
 */
export const MIDDLEGAME_FROM = BUCKETS[1]?.from ?? 0;
export const MIDDLEGAME_TO = BUCKETS[2]?.to ?? 0;
export const MIDDLEGAME = `${MIDDLEGAME_FROM.toFixed(2)}-${MIDDLEGAME_TO.toFixed(2)}`;

export function bucketedStats(thinks: Think[]): Record<string, BucketStats> {
	const byBucket = new Map<string, number[]>();
	for (const b of BUCKETS) byBucket.set(b.label, []);
	for (const t of thinks) {
		const label = bucketOf(t.fraction);
		if (label) byBucket.get(label)?.push(t.thinkS);
	}
	const out: Record<string, BucketStats> = {
		[OVERALL]: statsOf(thinks.map((t) => t.thinkS)),
		[MIDDLEGAME]: statsOf(
			thinks
				.filter((t) => t.fraction <= MIDDLEGAME_FROM && t.fraction >= MIDDLEGAME_TO)
				.map((t) => t.thinkS)
		),
	};
	for (const [label, values] of byBucket) out[label] = statsOf(values);
	return out;
}

// ---------------------------------------------------------------------------- the window

export interface GameRow {
	index: number;
	date: string;
	ourElo: number;
	oppElo: number;
	ourSide: 0 | 1;
	ourThinks: Think[];
	oppThinks: Think[];
	lostOnTime: boolean;
	termination: string;
}

export interface WindowOptions {
	account: string;
	baseSec: number;
	incSec: number;
	minOurElo: number;
	minOppElo: number;
	minOurMoves: number;
}

export function selectWindow(games: ParsedGame[], o: WindowOptions): GameRow[] {
	const rows: GameRow[] = [];
	const account = o.account.toLowerCase();
	const tcWanted = o.incSec === 0 ? `${o.baseSec}` : `${o.baseSec}+${o.incSec}`;
	games.forEach((game, index) => {
		const h = game.headers;
		if ((h.TimeControl ?? "") !== tcWanted) return;
		const white = (h.White ?? "").toLowerCase();
		const black = (h.Black ?? "").toLowerCase();
		const ourSide: 0 | 1 | null = white === account ? 0 : black === account ? 1 : null;
		if (ourSide === null) return;
		const ourElo = Number(ourSide === 0 ? h.WhiteElo : h.BlackElo);
		const oppElo = Number(ourSide === 0 ? h.BlackElo : h.WhiteElo);
		if (!Number.isFinite(ourElo) || !Number.isFinite(oppElo)) return;
		if (ourElo < o.minOurElo || oppElo < o.minOppElo) return;
		const ourThinks = thinksOf(game, ourSide, o.baseSec, o.incSec);
		if (ourThinks.length < o.minOurMoves) return;
		const oppSide: 0 | 1 = ourSide === 0 ? 1 : 0;
		const termination = h.Termination ?? "";
		rows.push({
			index,
			date: h.Date ?? "",
			ourElo,
			oppElo,
			ourSide,
			ourThinks,
			oppThinks: thinksOf(game, oppSide, o.baseSec, o.incSec),
			lostOnTime: /on time/i.test(termination) && !termination.toLowerCase().startsWith(account),
			termination,
		});
	});
	return rows;
}

export interface Milestone {
	move: number;
	ourGames: number;
	oursS: number;
	humanGames: number;
	humanS: number;
}

/**
 * Median clock left after each side's n-th move. Each side is counted over the games **that side**
 * reached the move in, so a game that ended on our 29th move still contributes the human's 30th —
 * the two n's therefore differ by a game or two deep into a 3+0.
 */
export function clockMilestones(rows: GameRow[]): Milestone[] {
	const medianAfter = (thinks: Think[][], move: number): { n: number; s: number } => {
		const left = thinks
			.map((game) => game.find((t) => t.moveNo === move)?.clockAfterS)
			.filter((v): v is number => v !== undefined)
			.sort((a, b) => a - b);
		return { n: left.length, s: round(percentile(left, 50), 1) };
	};
	return CLOCK_MILESTONES.map((move) => {
		const ours = medianAfter(
			rows.map((r) => r.ourThinks),
			move
		);
		const human = medianAfter(
			rows.map((r) => r.oppThinks),
			move
		);
		return {
			move,
			ourGames: ours.n,
			oursS: ours.s,
			humanGames: human.n,
			humanS: human.s,
		};
	});
}

// ---------------------------------------------------------------------------- the fixture

export interface ClockReference {
	generatedBy: string;
	source: { pgn: string; account: string; games: number };
	window: {
		timeControl: string;
		baseSec: number;
		incSec: number;
		minOurElo: number;
		minOppElo: number;
		minOurMoves: number;
		games: number;
		ourEloRange: [number, number];
		oppEloRange: [number, number];
		lostOnTime: number;
	};
	buckets: readonly BucketSpec[];
	/** The control: the human opponent of each game in the window. */
	human: Record<string, BucketStats>;
	/** The same games, our side — the "before" the acceptance tests are measured against. */
	sliced: Record<string, BucketStats>;
	/** Median clock left after the n-th move, both sides of the same games. */
	clockLeftAfterMove: Milestone[];
	/** The last `n` games of the window, where the regime moved faster than the 27-game mean. */
	recent: {
		games: number;
		human: Record<string, BucketStats>;
		sliced: Record<string, BucketStats>;
		clockLeftAfterMove: Milestone[];
	};
}

export function buildReference(
	games: ParsedGame[],
	o: WindowOptions & { pgn: string; recent: number }
): ClockReference {
	const rows = selectWindow(games, o);
	if (rows.length === 0) throw new Error("no games matched the window");
	const recent = rows.slice(-o.recent);
	const eloRange = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
	return {
		generatedBy: "tools/pgn-clock-reference.ts",
		source: { pgn: path.basename(o.pgn), account: o.account, games: games.length },
		window: {
			timeControl: `${o.baseSec}+${o.incSec}`,
			baseSec: o.baseSec,
			incSec: o.incSec,
			minOurElo: o.minOurElo,
			minOppElo: o.minOppElo,
			minOurMoves: o.minOurMoves,
			games: rows.length,
			ourEloRange: eloRange(rows.map((r) => r.ourElo)),
			oppEloRange: eloRange(rows.map((r) => r.oppElo)),
			lostOnTime: rows.filter((r) => r.lostOnTime).length,
		},
		buckets: BUCKETS,
		human: bucketedStats(rows.flatMap((r) => r.oppThinks)),
		sliced: bucketedStats(rows.flatMap((r) => r.ourThinks)),
		clockLeftAfterMove: clockMilestones(rows),
		recent: {
			games: recent.length,
			human: bucketedStats(recent.flatMap((r) => r.oppThinks)),
			sliced: bucketedStats(recent.flatMap((r) => r.ourThinks)),
			clockLeftAfterMove: clockMilestones(recent),
		},
	};
}

// ---------------------------------------------------------------------------- cli

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

function table(reference: ClockReference): string {
	const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
	const lines = [
		`window: ${reference.window.games} games, ${reference.window.timeControl}, ` +
			`our Elo ${reference.window.ourEloRange.join("–")}, ` +
			`opp Elo ${reference.window.oppEloRange.join("–")}, ` +
			`${reference.window.lostOnTime} lost on time`,
		"",
		"| fraction of base | human n | human median | human mean | human <1 s | human >10 s | our median | our mean | our <1 s |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const label of [...BUCKETS.map((b) => b.label), MIDDLEGAME, OVERALL]) {
		const h = reference.human[label];
		const s = reference.sliced[label];
		if (!h || !s) continue;
		lines.push(
			`| ${label} | ${h.n} | ${h.medianS.toFixed(2)} | ${h.meanS.toFixed(2)} | ${pct(h.shareUnder1s)} | ` +
				`${pct(h.shareOver10s)} | ${s.medianS.toFixed(2)} | ${s.meanS.toFixed(2)} | ${pct(s.shareUnder1s)} |`
		);
	}
	lines.push(
		"",
		"| after move | our games | ours | human games | human |",
		"|---|---:|---:|---:|---:|"
	);
	for (const m of reference.clockLeftAfterMove)
		lines.push(`| ${m.move} | ${m.ourGames} | ${m.oursS} | ${m.humanGames} | ${m.humanS} |`);
	const critical = reference.human[BUCKETS[1]?.label ?? ""];
	if (critical)
		lines.push(
			"",
			`human deciles in ${BUCKETS[1]?.label} (n=${critical.n}): ` +
				Object.entries(critical.percentiles)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ")
		);
	const ours = reference.sliced[BUCKETS[1]?.label ?? ""];
	if (ours)
		lines.push(
			`ours   deciles in ${BUCKETS[1]?.label} (n=${ours.n}): ` +
				Object.entries(ours.percentiles)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ")
		);
	return lines.join("\n");
}

if (import.meta.main) {
	const pgn = arg("pgn");
	if (!pgn) throw new Error("--pgn FILE is required");
	const root = path.resolve(import.meta.dir, "..");
	const out = path.resolve(root, arg("out", "test/fixtures/timing/human-blitz-clock.json") ?? "");
	const tc = parseTimeControl(arg("tc", "180") ?? "180");
	if (!tc) throw new Error("--tc must look like 180 or 180+2");
	const reference = buildReference(parseGames(await Bun.file(path.resolve(pgn)).text()), {
		pgn,
		account: arg("account", "gc_elif") ?? "gc_elif",
		baseSec: tc.baseSec,
		incSec: tc.incSec,
		minOurElo: Number(arg("min-our-elo", "2400")),
		minOppElo: Number(arg("min-opp-elo", "2200")),
		minOurMoves: Number(arg("min-our-moves", "12")),
		recent: Number(arg("recent", "10")),
	});
	process.stdout.write(`${table(reference)}\n`);
	if (process.argv.includes("--print")) process.exit(0);
	await Bun.write(out, `${JSON.stringify(reference, null, "\t")}\n`);
	process.stdout.write(`\nwrote ${path.relative(root, out)}\n`);
}
