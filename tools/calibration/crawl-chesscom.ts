/**
 * tools/calibration/crawl-chesscom.ts — targeted crawl of chess.com rated games for the Maia
 * strength calibration (data acquisition stage; `build-corpus.ts` turns the result into rows).
 *
 *     bun tools/calibration/crawl-chesscom.ts                       # crawl until full or 6000 requests
 *     bun tools/calibration/crawl-chesscom.ts --max-requests 500    # a chunk; rerun to resume
 *     bun tools/calibration/crawl-chesscom.ts --rule-only           # re-derive time-class-rule.json
 *
 * Options: --max-requests N (network requests this run, default 6000), --target N (samples per
 * cell, default 110), --per-player N (samples per player per cell, default 2), --stall N (visits
 * to a cell without a new sample before it is set aside, default 40), --seed N (RNG seed).
 *
 * Cells are time class (bullet / blitz / rapid) × rating bucket (600, 800, …, 3000; a side counts
 * for the nearest centre within ± 100). A sample is a (game, side) pair; it counts only toward its
 * own time class. The crawl is serial (chess.com rate-limits parallel clients), caches every
 * response body under `data/calibration/http-cache/` (gzipped, keyed by sha1 of the URL) so a
 * rerun never refetches, and keeps its frontier in `crawl-state.json`, so it is resumable.
 *
 * Player choice: every player seen (seeds from the titled lists and leaderboards, then every
 * opponent in every fetched game) is filed under the cell of each last-seen rating; the next
 * visit is a random unvisited player from the least-filled cell that still has one. Following
 * low-rated opponents of low-rated players is how the crawl reaches 600–1000.
 *
 * Outputs (all under `data/calibration/`, git-ignored): `games.jsonl` (accepted games that
 * yielded a sample, deduped by uuid), `samples.jsonl` ({uuid, side, tc, bucket, player}),
 * `time-class-rule.json` (time_control → time_class counts over every fetched live game, and
 * the check of `timeClassFor` against chess.com's own label).
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	BUCKETS,
	bucketFor,
	cellKey,
	MONTH_FIRST,
	MONTH_LAST,
	PATHS,
	parseTimeControl,
	type Sample,
	type StoredGame,
	TIME_CLASSES,
	type TimeClass,
	timeClassFor,
} from "./common";

const API = "https://api.chess.com/pub";
const USER_AGENT = "sliced-calibration-research/1.0";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** Seed titles and the rating each is assumed to hold until a real game shows otherwise. */
const TITLE_GUESS: Record<string, number> = {
	GM: 2650,
	IM: 2450,
	WGM: 2300,
	FM: 2350,
	WIM: 2200,
	CM: 2200,
	NM: 2200,
	WFM: 2050,
};
const LEADERBOARDS: Record<string, TimeClass> = {
	live_bullet: "bullet",
	live_blitz: "blitz",
	live_rapid: "rapid",
};
/** Fetch the second-latest in-window month when the latest gave fewer accepted games. */
const SECOND_MONTH_BELOW = 40;
const PROGRESS_EVERY = 50;

// ── args ─────────────────────────────────────────────────────────────────────────────────────

interface Args {
	maxRequests: number;
	target: number;
	perPlayer: number;
	stall: number;
	seed: number;
	ruleOnly: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		maxRequests: 6000,
		target: 110,
		perPlayer: 2,
		stall: 40,
		seed: 7,
		ruleOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = (): number => {
			const v = Number(argv[++i]);
			if (!Number.isFinite(v)) throw new Error(`${a} needs a number`);
			return v;
		};
		if (a === "--max-requests") args.maxRequests = next();
		else if (a === "--target") args.target = next();
		else if (a === "--per-player") args.perPlayer = next();
		else if (a === "--stall") args.stall = next();
		else if (a === "--seed") args.seed = next();
		else if (a === "--rule-only") args.ruleOnly = true;
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

// ── http with an on-disk cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
	url: string;
	status: number;
	body: unknown;
}

function cachePath(url: string): string {
	return path.join(PATHS.cache, `${createHash("sha1").update(url).digest("hex")}.json.gz`);
}

function readCache(file: string): CacheEntry | null {
	if (!existsSync(file)) return null;
	try {
		const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)));
		return JSON.parse(text) as CacheEntry;
	} catch {
		return null;
	}
}

class Http {
	requests = 0;
	constructor(private readonly budget: number) {}

	get exhausted(): boolean {
		return this.requests >= this.budget;
	}

	/** The JSON body (null on 404/410/other client errors), or "budget" when out of requests. */
	async get(url: string): Promise<unknown | "budget"> {
		const file = cachePath(url);
		const hit = readCache(file);
		if (hit) return hit.body;
		if (this.exhausted) return "budget";
		for (let attempt = 0; ; attempt++) {
			this.requests++;
			let status = 0;
			let body: unknown = null;
			try {
				const res = await fetch(url, {
					headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				});
				status = res.status;
				if (res.ok) body = await res.json();
				else await res.arrayBuffer();
			} catch (err) {
				status = 0;
				process.stderr.write(`  network error on ${url}: ${String(err)}\n`);
			}
			const transient = status === 0 || status === 429 || status >= 500;
			if (!transient) {
				const entry: CacheEntry = { url, status, body };
				writeFileSync(file, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(entry))));
				return body;
			}
			if (attempt >= 6 || this.exhausted) {
				process.stderr.write(`  giving up on ${url} (status ${status})\n`);
				return null;
			}
			const wait = Math.min(120_000, 2_000 * 2 ** attempt);
			process.stderr.write(`  ${status} on ${url}; retrying in ${wait / 1000}s\n`);
			await Bun.sleep(wait);
		}
	}
}

// ── archive game shape ───────────────────────────────────────────────────────────────────────

interface ArchiveSide {
	username?: string;
	rating?: number;
	result?: string;
}

interface ArchiveGame {
	url?: string;
	uuid?: string;
	pgn?: string;
	time_control?: string;
	time_class?: string;
	rules?: string;
	rated?: boolean;
	end_time?: number;
	initial_setup?: string;
	white?: ArchiveSide;
	black?: ArchiveSide;
}

function isTimeClass(s: string | undefined): s is TimeClass {
	return s === "bullet" || s === "blitz" || s === "rapid";
}

/** Count of `[%clk` comments, which chess.com writes once per ply. */
function clockCount(pgn: string): number {
	let n = 0;
	let i = pgn.indexOf("[%clk");
	while (i !== -1) {
		n++;
		i = pgn.indexOf("[%clk", i + 5);
	}
	return n;
}

/** The corpus filter; returns the stored shape, or null when the game is out. */
export function acceptGame(g: ArchiveGame): StoredGame | null {
	if (g.rules !== "chess" || g.rated !== true || !isTimeClass(g.time_class)) return null;
	if (!g.uuid || !g.pgn || !g.time_control || !g.white || !g.black) return null;
	if (g.initial_setup && g.initial_setup !== START_FEN) return null;
	if (/\[SetUp "1"\]/.test(g.pgn) || /\[FEN "/.test(g.pgn)) return null;
	const w = g.white;
	const b = g.black;
	if (!w.username || !b.username || !(Number(w.rating) > 0) || !(Number(b.rating) > 0)) return null;
	if (!parseTimeControl(g.time_control)) return null;
	if (clockCount(g.pgn) < 20) return null;
	return {
		uuid: g.uuid,
		url: g.url ?? "",
		end_time: g.end_time ?? 0,
		time_control: g.time_control,
		time_class: g.time_class,
		white: { username: w.username, rating: Number(w.rating), result: w.result ?? "" },
		black: { username: b.username, rating: Number(b.rating), result: b.result ?? "" },
		pgn: g.pgn,
	};
}

// ── crawl state ──────────────────────────────────────────────────────────────────────────────

type Ratings = Partial<Record<TimeClass, number>> & { guess?: boolean };

interface PersistedState {
	visited: string[];
	players: Record<string, Ratings>;
	requestsTotal: number;
	seeded: boolean;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

class Crawl {
	readonly visited = new Set<string>();
	readonly players = new Map<string, Ratings>();
	/** Unvisited candidates per cell (lazily validated when popped). */
	readonly candidates = new Map<string, string[]>();
	readonly inList = new Map<string, Set<string>>();
	readonly fill = new Map<string, number>();
	readonly perPlayerCell = new Map<string, number>();
	readonly sampleKeys = new Set<string>();
	readonly gameUuids = new Set<string>();
	readonly stall = new Map<string, number>();
	requestsBefore = 0;
	seeded = false;
	private readonly random: () => number;

	constructor(
		readonly args: Args,
		readonly http: Http
	) {
		this.random = rng(args.seed);
		for (const tc of TIME_CLASSES) {
			for (const b of BUCKETS) {
				const k = cellKey(tc, b);
				this.candidates.set(k, []);
				this.inList.set(k, new Set());
				this.fill.set(k, 0);
				this.stall.set(k, 0);
			}
		}
	}

	load(): void {
		if (existsSync(PATHS.state)) {
			const s = JSON.parse(readFileSync(PATHS.state, "utf8")) as PersistedState;
			for (const v of s.visited) this.visited.add(v);
			for (const [name, r] of Object.entries(s.players)) this.players.set(name, r);
			this.requestsBefore = s.requestsTotal;
			this.seeded = s.seeded;
		}
		if (existsSync(PATHS.samples)) {
			for (const line of readFileSync(PATHS.samples, "utf8").split("\n")) {
				if (!line.trim()) continue;
				const s = JSON.parse(line) as Sample;
				this.sampleKeys.add(`${s.uuid}:${s.side}`);
				const k = cellKey(s.tc, s.bucket);
				this.fill.set(k, (this.fill.get(k) ?? 0) + 1);
				const pk = `${k}:${s.player}`;
				this.perPlayerCell.set(pk, (this.perPlayerCell.get(pk) ?? 0) + 1);
			}
		}
		if (existsSync(PATHS.games)) {
			for (const line of readFileSync(PATHS.games, "utf8").split("\n")) {
				const m = /"uuid":"([^"]+)"/.exec(line);
				if (m?.[1]) this.gameUuids.add(m[1]);
			}
		}
		for (const [name, r] of this.players) {
			if (!this.visited.has(name)) this.file(name, r);
		}
	}

	save(): void {
		const s: PersistedState = {
			visited: [...this.visited],
			players: Object.fromEntries(this.players),
			requestsTotal: this.requestsBefore + this.http.requests,
			seeded: this.seeded,
		};
		writeFileSync(PATHS.state, JSON.stringify(s));
	}

	private full(k: string): boolean {
		return (this.fill.get(k) ?? 0) >= this.args.target;
	}

	allFull(): boolean {
		for (const [k] of this.fill) if (!this.full(k)) return false;
		return true;
	}

	/** File an unvisited player under each cell its ratings fall in. */
	private file(name: string, r: Ratings): void {
		for (const tc of TIME_CLASSES) {
			const rating = r[tc];
			if (rating === undefined) continue;
			const b = bucketFor(rating);
			if (b === null) continue;
			const k = cellKey(tc, b);
			const set = this.inList.get(k);
			if (!set || set.has(name) || this.full(k)) continue;
			set.add(name);
			this.candidates.get(k)?.push(name);
		}
	}

	notePlayer(username: string, tc: TimeClass, rating: number, guess = false): void {
		const name = username.toLowerCase();
		let r = this.players.get(name);
		if (!r) {
			r = {};
			this.players.set(name, r);
		}
		if (!guess && r.guess) {
			for (const t of TIME_CLASSES) delete r[t];
			delete r.guess;
		}
		if (guess && r[tc] !== undefined && !r.guess) return;
		r[tc] = rating;
		if (guess) r.guess = true;
		if (!this.visited.has(name)) this.file(name, r);
	}

	/** The next player to visit and the cell that chose them, or null when the frontier is dry. */
	next(): { name: string; cell: string } | null {
		const cells = [...this.fill.entries()]
			.filter(([k]) => !this.full(k) && (this.stall.get(k) ?? 0) < this.args.stall)
			.sort((a, b) => a[1] - b[1] || this.random() - 0.5);
		for (const [k] of cells) {
			const list = this.candidates.get(k);
			const set = this.inList.get(k);
			if (!list || !set) continue;
			const [tc, bucketStr] = k.split(":") as [TimeClass, string];
			while (list.length > 0) {
				const i = Math.floor(this.random() * list.length);
				const name = list[i] as string;
				list[i] = list[list.length - 1] as string;
				list.pop();
				set.delete(name);
				if (this.visited.has(name)) continue;
				const rating = this.players.get(name)?.[tc];
				if (rating === undefined || bucketFor(rating) !== Number(bucketStr)) continue;
				return { name, cell: k };
			}
		}
		return null;
	}

	/** Try both sides of an accepted game as samples; returns how many were added. */
	takeSamples(g: StoredGame): number {
		let added = 0;
		for (const side of ["w", "b"] as const) {
			const s = side === "w" ? g.white : g.black;
			const bucket = bucketFor(s.rating);
			if (bucket === null) continue;
			const k = cellKey(g.time_class, bucket);
			if (this.full(k)) continue;
			const key = `${g.uuid}:${side}`;
			if (this.sampleKeys.has(key)) continue;
			const player = s.username.toLowerCase();
			const pk = `${k}:${player}`;
			if ((this.perPlayerCell.get(pk) ?? 0) >= this.args.perPlayer) continue;
			const sample: Sample = { uuid: g.uuid, side, tc: g.time_class, bucket, player };
			appendFileSync(PATHS.samples, `${JSON.stringify(sample)}\n`);
			this.sampleKeys.add(key);
			this.perPlayerCell.set(pk, (this.perPlayerCell.get(pk) ?? 0) + 1);
			this.fill.set(k, (this.fill.get(k) ?? 0) + 1);
			this.stall.set(k, 0);
			added++;
		}
		if (added > 0 && !this.gameUuids.has(g.uuid)) {
			appendFileSync(PATHS.games, `${JSON.stringify(g)}\n`);
			this.gameUuids.add(g.uuid);
		}
		return added;
	}

	/** Process one monthly archive; returns the number of accepted games in it. */
	processArchive(body: unknown): number {
		const games = (body as { games?: ArchiveGame[] } | null)?.games ?? [];
		let accepted = 0;
		for (const g of games) {
			if (g.rules === "chess" && g.rated === true && isTimeClass(g.time_class)) {
				const tc = g.time_class;
				if (g.white?.username && Number(g.white.rating) > 0)
					this.notePlayer(g.white.username, tc, Number(g.white.rating));
				if (g.black?.username && Number(g.black.rating) > 0)
					this.notePlayer(g.black.username, tc, Number(g.black.rating));
			}
			const stored = acceptGame(g);
			if (!stored) continue;
			accepted++;
			this.takeSamples(stored);
		}
		return accepted;
	}

	async seed(): Promise<void> {
		if (this.seeded) return;
		const boards = await this.http.get(`${API}/leaderboards`);
		if (boards === "budget") return;
		const lb = (boards ?? {}) as Record<string, Array<{ username?: string; score?: number }>>;
		for (const [board, tc] of Object.entries(LEADERBOARDS)) {
			for (const p of lb[board] ?? []) {
				if (p.username && p.score) this.notePlayer(p.username, tc, p.score);
			}
		}
		for (const [title, guess] of Object.entries(TITLE_GUESS)) {
			const res = await this.http.get(`${API}/titled/${title}`);
			if (res === "budget") return;
			for (const name of (res as { players?: string[] } | null)?.players ?? []) {
				for (const tc of TIME_CLASSES) this.notePlayer(name, tc, guess, true);
			}
		}
		this.seeded = true;
	}

	/** Visit one player: archive list, then the latest one or two in-window months. */
	async visit(name: string): Promise<"ok" | "budget"> {
		const archives = await this.http.get(`${API}/player/${encodeURIComponent(name)}/games/archives`);
		if (archives === "budget") return "budget";
		this.visited.add(name);
		const urls = ((archives as { archives?: string[] } | null)?.archives ?? [])
			.filter((u) => {
				const m = /\/games\/(\d{4}\/\d{2})$/.exec(u);
				return m?.[1] !== undefined && m[1] >= MONTH_FIRST && m[1] <= MONTH_LAST;
			})
			.sort()
			.reverse()
			.slice(0, 2);
		for (let i = 0; i < urls.length; i++) {
			const body = await this.http.get(urls[i] as string);
			if (body === "budget") return "budget";
			const accepted = this.processArchive(body);
			if (accepted >= SECOND_MONTH_BELOW) break;
		}
		return "ok";
	}

	table(): string {
		const lines = [`bucket  ${TIME_CLASSES.map((t) => t.padStart(8)).join("")}   (cands b/z/r)`];
		for (const b of BUCKETS) {
			const cells = TIME_CLASSES.map((tc) => String(this.fill.get(cellKey(tc, b)) ?? 0));
			const cands = TIME_CLASSES.map((tc) => this.inList.get(cellKey(tc, b))?.size ?? 0);
			lines.push(
				`${String(b).padStart(6)}  ${cells.map((c) => c.padStart(8)).join("")}   ${cands.join("/")}`
			);
		}
		return lines.join("\n");
	}
}

// ── time-class rule from the cache ───────────────────────────────────────────────────────────

interface RuleReport {
	rule: string;
	gamesChecked: number;
	mismatches: number;
	mismatchExamples: Array<{ time_control: string; time_class: string; predicted: string }>;
	/** time_control → chess.com time_class → count, over every distinct live standard game fetched. */
	counts: Record<string, Record<string, number>>;
	/** The same over the accepted (rated, standard, clocked) games only. */
	acceptedCounts: Record<string, Record<string, number>>;
	/** The estimated duration range (`base + 40 × inc`, s) chess.com assigned to each class. */
	effRange: Record<string, { min: number; max: number }>;
}

export function deriveTimeClassRule(): RuleReport {
	const counts: Record<string, Record<string, number>> = {};
	const acceptedCounts: Record<string, Record<string, number>> = {};
	const effRange: Record<string, { min: number; max: number }> = {};
	const seen = new Set<string>();
	let checked = 0;
	let mismatches = 0;
	const examples = new Map<
		string,
		{ time_control: string; time_class: string; predicted: string }
	>();
	for (const f of readdirSync(PATHS.cache)) {
		const entry = readCache(path.join(PATHS.cache, f));
		if (!entry || !/\/games\/\d{4}\/\d{2}$/.test(entry.url)) continue;
		const games = (entry.body as { games?: ArchiveGame[] } | null)?.games ?? [];
		for (const g of games) {
			if (!g.uuid || seen.has(g.uuid) || !g.time_control || !g.time_class) continue;
			if (g.rules !== "chess" || g.time_class === "daily") continue;
			seen.add(g.uuid);
			const tc = parseTimeControl(g.time_control);
			if (!tc) continue;
			const row = counts[g.time_control] ?? {};
			row[g.time_class] = (row[g.time_class] ?? 0) + 1;
			counts[g.time_control] = row;
			if (acceptGame(g)) {
				const arow = acceptedCounts[g.time_control] ?? {};
				arow[g.time_class] = (arow[g.time_class] ?? 0) + 1;
				acceptedCounts[g.time_control] = arow;
			}
			const eff = tc.baseS + 40 * tc.incS;
			const r = effRange[g.time_class] ?? { min: eff, max: eff };
			r.min = Math.min(r.min, eff);
			r.max = Math.max(r.max, eff);
			effRange[g.time_class] = r;
			checked++;
			const predicted = timeClassFor(tc.baseS, tc.incS);
			if (predicted !== g.time_class) {
				mismatches++;
				const key = `${g.time_control}:${g.time_class}`;
				if (!examples.has(key))
					examples.set(key, { time_control: g.time_control, time_class: g.time_class, predicted });
			}
		}
	}
	return {
		rule: "eff = base + 40*inc (s); bullet if eff < 180, blitz if eff < 600, else rapid",
		gamesChecked: checked,
		mismatches,
		mismatchExamples: [...examples.values()],
		counts,
		acceptedCounts,
		effRange,
	};
}

function writeRule(): void {
	const report = deriveTimeClassRule();
	writeFileSync(PATHS.timeClassRule, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(
		`time-class rule: ${report.gamesChecked} live games checked, ${report.mismatches} mismatches, ${Object.keys(report.counts).length} time controls`
	);
	for (const ex of report.mismatchExamples.slice(0, 20)) {
		console.log(`  mismatch ${ex.time_control}: chess.com ${ex.time_class}, rule ${ex.predicted}`);
	}
	console.log(`  eff ranges: ${JSON.stringify(report.effRange)}`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(PATHS.cache, { recursive: true });
	if (args.ruleOnly) {
		writeRule();
		return;
	}
	const http = new Http(args.maxRequests);
	const crawl = new Crawl(args, http);
	crawl.load();
	let stopping = false;
	process.on("SIGINT", () => {
		stopping = true;
	});
	await crawl.seed();
	let lastReport = 0;
	let visits = 0;
	let reason = "frontier exhausted";
	while (!stopping) {
		if (crawl.allFull()) {
			reason = "every cell full";
			break;
		}
		if (http.exhausted) {
			reason = "request budget spent";
			break;
		}
		const pick = crawl.next();
		if (!pick) break;
		const before = crawl.fill.get(pick.cell) ?? 0;
		const res = await crawl.visit(pick.name);
		if (res === "budget") {
			reason = "request budget spent";
			break;
		}
		visits++;
		if ((crawl.fill.get(pick.cell) ?? 0) === before) {
			crawl.stall.set(pick.cell, (crawl.stall.get(pick.cell) ?? 0) + 1);
		}
		if (http.requests - lastReport >= PROGRESS_EVERY) {
			lastReport = http.requests;
			crawl.save();
			console.log(
				`\n[${http.requests} requests this run, ${visits} visits, ${crawl.players.size} players known]`
			);
			console.log(crawl.table());
		}
	}
	if (stopping) reason = "interrupted";
	crawl.save();
	console.log(`\nstopped: ${reason}`);
	console.log(
		`requests this run ${http.requests}, total ${crawl.requestsBefore + http.requests}, visits ${visits}, samples ${crawl.sampleKeys.size}, games ${crawl.gameUuids.size}`
	);
	console.log(crawl.table());
	const short = [...crawl.fill.entries()].filter(([, n]) => n < args.target);
	if (short.length > 0) {
		console.log(`under-filled cells: ${short.map(([k, n]) => `${k}=${n}`).join(", ")}`);
	}
	writeRule();
}

if (import.meta.main) {
	await main();
}
