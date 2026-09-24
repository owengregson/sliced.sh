/**
 * tools/timing-crawl/crawl.ts — snowball crawl of chess.com live games with a clock on every move,
 * for the think-time model. The pure rules (filters, bands, caps, priorities) live in
 * `policy.ts`, which documents the definitions `games.jsonl` is written under.
 *
 *     bun tools/timing-crawl/crawl.ts --data <dir> --calib <dir>        # run / resume
 *     nohup bun tools/timing-crawl/crawl.ts --data D --calib C >> D/crawl.log 2>&1 &
 *
 * Options: --target N (kept sides per cell counted as "met", 4000), --cell-cap N (no side is kept
 * in a cell once it holds N, 8000), --goal-games N (250000), --per-player N (150),
 * --per-player-tc N (30), --stall N and --min-yield Y (a cell is parked for this run once its
 * last N focused visits added fewer than Y kept sides per network request; 20, 0.5),
 * --few-months N (months per visit below --scarce-from, 3), --scarce-from R (2000:
 * players picked for a band ≥ R get every in-window month), --cand-cap N (candidates kept per
 * cell, 5000), --harvest N (opponent sides kept per cell per visit, spread over its months,
 * 250 — so no cell is filled by the opponents of a handful of players), --max-requests N, --report-every S (180), --seed N.
 *
 * Network: strictly serial, `sliced-calibration-research/1.0`, exponential backoff on 429 / 5xx /
 * network errors (honouring Retry-After). Every response body is cached gzipped under
 * `<data>/http-cache/` keyed by sha1(url) (the calibration crawl's format); `<calib>/http-cache/`
 * is read as a first-level cache and never written. A 404/410 is cached as a null body.
 *
 * Resumability (kill -9 safe): `games.jsonl` (append-only, one full line per write) is the truth
 * for fills and caps and is replayed on start after dropping a torn last line; `moves.jsonl`
 * lines missing for stored games are regenerated; the frontier (visited players, candidates per
 * cell) is snapshotted atomically to `state.json`. A lost snapshot costs only cache hits.
 *
 * Outputs under `<data>`: `games.jsonl` (TimingGame per line), `moves.jsonl` (MovesRecord per
 * line), `summary.json`, `STATUS.md`, `state.json`, `http-cache/`.
 *
 * Player choice: every opponent seen in a fetched month (and the titled lists, the leaderboards,
 * the calibration corpus' players) is filed as a candidate under the cell of the rating it had
 * in that game, while that cell is open and the player has room. The next visit takes a random
 * candidate from the most under-filled open cell (fill / target). A visit fetches the player's
 * archive list and then a random selection of in-window months (all of them for scarce bands),
 * rationing the player's own sides per month; opponents' sides in those months are kept whenever
 * they are eligible.
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { type StoredGame, TIME_CLASSES, type TimeClass } from "../calibration/common";
import {
	ALL_CELLS,
	archiveMonth,
	BANDS,
	bandFor,
	type Caps,
	type Colour,
	cellOf,
	Ledger,
	MONTH_FIRST,
	MONTH_LAST,
	maxMonthsFor,
	monthQuota,
	movesRecord,
	parseCell,
	prefilter,
	qualifyArchive,
	qualifyStored,
	type RawGame,
	rankCells,
	rng,
	shouldPark,
	shuffle,
	type TimingGame,
	timingGame,
	type VisitYield,
} from "./policy";

const API = "https://api.chess.com/pub";
const USER_AGENT = "sliced-calibration-research/1.0";
const TITLES: Record<string, number> = {
	GM: 2600,
	IM: 2400,
	WGM: 2300,
	FM: 2300,
	WIM: 2200,
	CM: 2200,
	NM: 2200,
	WFM: 2000,
	WCM: 1900,
	WNM: 1900,
};
const LEADERBOARDS: Record<string, TimeClass> = {
	live_bullet: "bullet",
	live_blitz: "blitz",
	live_rapid: "rapid",
};

// ── args ─────────────────────────────────────────────────────────────────────────────────────

interface Args {
	data: string;
	calib: string;
	target: number;
	cellCap: number;
	goalGames: number;
	perPlayer: number;
	perPlayerTc: number;
	stall: number;
	minYield: number;
	fewMonths: number;
	scarceFrom: number;
	candCap: number;
	harvest: number;
	maxRequests: number;
	reportEvery: number;
	seed: number;
}

function parseArgs(argv: string[]): Args {
	const a: Args = {
		data: path.resolve(import.meta.dir, "../../data/timing/crawl"),
		calib: path.resolve(import.meta.dir, "../../data/calibration"),
		target: 4000,
		cellCap: 8000,
		goalGames: 250_000,
		perPlayer: 150,
		perPlayerTc: 30,
		stall: 20,
		minYield: 0.5,
		fewMonths: 3,
		scarceFrom: 2000,
		candCap: 5_000,
		harvest: 250,
		maxRequests: Number.POSITIVE_INFINITY,
		reportEvery: 180,
		seed: 11,
	};
	const nums: Record<string, keyof Args> = {
		"--target": "target",
		"--cell-cap": "cellCap",
		"--goal-games": "goalGames",
		"--per-player": "perPlayer",
		"--per-player-tc": "perPlayerTc",
		"--stall": "stall",
		"--min-yield": "minYield",
		"--few-months": "fewMonths",
		"--scarce-from": "scarceFrom",
		"--cand-cap": "candCap",
		"--harvest": "harvest",
		"--max-requests": "maxRequests",
		"--report-every": "reportEvery",
		"--seed": "seed",
	};
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i] as string;
		const v = argv[++i];
		if (v === undefined) throw new Error(`${k} needs a value`);
		if (k === "--data") a.data = path.resolve(v);
		else if (k === "--calib") a.calib = path.resolve(v);
		else if (nums[k]) {
			const n = Number(v);
			if (!Number.isFinite(n)) throw new Error(`${k} needs a number`);
			(a as unknown as Record<string, number>)[nums[k] as string] = n;
		} else throw new Error(`unknown argument ${k}`);
	}
	return a;
}

// ── files ────────────────────────────────────────────────────────────────────────────────────

function atomicWrite(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Drop a torn last line (a crash mid-append) so the next append starts on a fresh line. */
function dropTornTail(file: string): void {
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

/** Parsed lines of a JSONL file, read in 8 MB chunks (the file can be gigabytes). */
function* jsonLines<T>(file: string): Generator<T> {
	if (!existsSync(file)) return;
	const fd = openSync(file, "r");
	const buf = Buffer.alloc(8 << 20);
	const decoder = new TextDecoder();
	let carry = "";
	try {
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			const text = carry + (n > 0 ? decoder.decode(buf.subarray(0, n), { stream: true }) : "");
			const lines = text.split("\n");
			carry = n > 0 ? (lines.pop() ?? "") : "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					yield JSON.parse(line) as T;
				} catch {
					// a torn line; skipped
				}
			}
			if (n <= 0) break;
		}
	} finally {
		closeSync(fd);
	}
}

// ── http with a two-level on-disk cache ──────────────────────────────────────────────────────

interface CacheEntry {
	url: string;
	status: number;
	body: unknown;
}

class TransientError extends Error {}

function cacheName(url: string): string {
	return `${createHash("sha1").update(url).digest("hex")}.json.gz`;
}

function readCache(file: string): CacheEntry | null {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)))) as CacheEntry;
	} catch {
		return null;
	}
}

class Http {
	net = 0;
	hitsOwn = 0;
	hitsCalib = 0;
	retries = 0;
	latencyMsTotal = 0;
	bytes = 0;
	constructor(
		private readonly own: string,
		private readonly calib: string,
		private readonly budget: number
	) {}

	get exhausted(): boolean {
		return this.net >= this.budget;
	}

	async get(url: string): Promise<unknown> {
		const name = cacheName(url);
		const ownFile = path.join(this.own, name);
		const mine = readCache(ownFile);
		if (mine) {
			this.hitsOwn++;
			return mine.body;
		}
		const theirs = readCache(path.join(this.calib, name));
		if (theirs && theirs.url === url) {
			this.hitsCalib++;
			return theirs.body;
		}
		for (let attempt = 0; ; attempt++) {
			this.net++;
			let status = 0;
			let body: unknown = null;
			let retryAfter = 0;
			const t0 = performance.now();
			try {
				const res = await fetch(url, {
					headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
					signal: AbortSignal.timeout(120_000),
				});
				status = res.status;
				retryAfter = Number(res.headers.get("retry-after") ?? 0) || 0;
				if (res.ok) {
					const text = await res.text();
					this.bytes += text.length;
					body = JSON.parse(text);
				} else await res.arrayBuffer();
			} catch (err) {
				status = 0;
				log(`  network error on ${url}: ${String(err)}`);
			}
			this.latencyMsTotal += performance.now() - t0;
			const transient = status === 0 || status === 429 || status >= 500;
			if (!transient) {
				const entry: CacheEntry = { url, status, body };
				const tmp = `${ownFile}.tmp`;
				writeFileSync(tmp, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(entry))));
				renameSync(tmp, ownFile);
				return status >= 200 && status < 300 ? body : null;
			}
			this.retries++;
			if (attempt >= 7) throw new TransientError(`giving up on ${url} (status ${status})`);
			const wait = Math.min(300_000, Math.max(retryAfter * 1000, 2_000 * 2 ** attempt));
			log(`  ${status} on ${url}; retrying in ${Math.round(wait / 1000)}s`);
			await Bun.sleep(wait);
		}
	}
}

function log(msg: string): void {
	console.log(`${new Date().toISOString().slice(0, 19)} ${msg}`);
}

// ── crawl ────────────────────────────────────────────────────────────────────────────────────

interface Persisted {
	visited: string[];
	candidates: Record<string, string[]>;
	seeded: boolean;
	ingested: boolean;
	requests: number;
	visits: number;
	startedAt: number;
}

class Crawl {
	readonly ledger: Ledger;
	readonly visited = new Set<string>();
	readonly candidates = new Map<string, string[]>();
	readonly inCell = new Map<string, Set<string>>();
	readonly stall = new Map<string, VisitYield[]>();
	readonly parked = new Set<string>();
	readonly random: () => number;
	readonly paths;
	readonly http: Http;
	moveUuids = new Set<string>();
	seeded = false;
	ingested = false;
	requestsBefore = 0;
	visitsBefore = 0;
	visits = 0;
	startedAt = Date.now();
	readonly runStart = Date.now();
	readonly history: Array<{ t: number; games: number }> = [];
	private pendingGames: string[] = [];
	private pendingMoves: string[] = [];

	constructor(readonly args: Args) {
		const caps: Caps = {
			perPlayer: args.perPlayer,
			perPlayerTc: args.perPlayerTc,
			cellCap: args.cellCap,
		};
		this.ledger = new Ledger(caps);
		this.random = rng(args.seed ^ (Date.now() & 0xffff));
		this.paths = {
			games: path.join(args.data, "games.jsonl"),
			moves: path.join(args.data, "moves.jsonl"),
			state: path.join(args.data, "state.json"),
			summary: path.join(args.data, "summary.json"),
			status: path.join(args.data, "STATUS.md"),
			cache: path.join(args.data, "http-cache"),
		};
		mkdirSync(this.paths.cache, { recursive: true });
		this.http = new Http(this.paths.cache, path.join(args.calib, "http-cache"), args.maxRequests);
		for (const c of ALL_CELLS) {
			this.candidates.set(c, []);
			this.inCell.set(c, new Set());
			this.stall.set(c, []);
		}
	}

	load(): void {
		dropTornTail(this.paths.games);
		dropTornTail(this.paths.moves);
		for (const m of jsonLines<{ uuid: string }>(this.paths.moves)) this.moveUuids.add(m.uuid);
		let regenerated = 0;
		for (const g of jsonLines<TimingGame>(this.paths.games)) {
			if (this.ledger.seen(g.uuid, g.url)) continue;
			this.ledger.record(g, { w: g.whiteKept, b: g.blackKept });
			if (!this.moveUuids.has(g.uuid)) {
				const prof = qualifyStored(g);
				if (prof) {
					appendFileSync(this.paths.moves, `${JSON.stringify(movesRecord(g, prof))}\n`);
					this.moveUuids.add(g.uuid);
					regenerated++;
				}
			}
		}
		if (existsSync(this.paths.state)) {
			const s = JSON.parse(readFileSync(this.paths.state, "utf8")) as Persisted;
			for (const v of s.visited) this.visited.add(v);
			for (const [cell, names] of Object.entries(s.candidates)) {
				for (const n of names) this.file(cell, n);
			}
			this.seeded = s.seeded;
			this.ingested = s.ingested;
			this.requestsBefore = s.requests;
			this.visitsBefore = s.visits;
			this.startedAt = s.startedAt;
		}
		log(
			`loaded ${this.ledger.games} games, ${this.ledger.sides} kept sides, ${this.visited.size} visited` +
				(regenerated ? `, regenerated ${regenerated} moves lines` : "")
		);
	}

	save(): void {
		const s: Persisted = {
			visited: [...this.visited],
			candidates: Object.fromEntries(this.candidates),
			seeded: this.seeded,
			ingested: this.ingested,
			requests: this.requestsBefore + this.http.net,
			visits: this.visitsBefore + this.visits,
			startedAt: this.startedAt,
		};
		atomicWrite(this.paths.state, JSON.stringify(s));
	}

	/** File a candidate under a cell (reservoir-capped). */
	file(cell: string, name: string): void {
		const set = this.inCell.get(cell);
		const list = this.candidates.get(cell);
		if (!set || !list || set.has(name) || this.visited.has(name)) return;
		if (list.length < this.args.candCap) {
			list.push(name);
			set.add(name);
			return;
		}
		const i = Math.floor(this.random() * list.length);
		set.delete(list[i] as string);
		list[i] = name;
		set.add(name);
	}

	/** File a player seen with this rating in this time class, when that could yield a side. */
	note(username: string, tc: TimeClass, rating: number): void {
		const name = username.toLowerCase();
		if (this.visited.has(name)) return;
		const band = bandFor(rating);
		if (band === null) return;
		const cell = cellOf(tc, band);
		if (this.ledger.fill(cell) >= this.args.cellCap || this.ledger.room(name, tc) <= 0) return;
		this.file(cell, name);
	}

	private flush(): void {
		if (this.pendingGames.length === 0) return;
		appendFileSync(this.paths.games, this.pendingGames.join(""));
		appendFileSync(this.paths.moves, this.pendingMoves.join(""));
		this.pendingGames = [];
		this.pendingMoves = [];
	}

	/** Store an admitted game (buffered per month so one append carries whole lines). */
	private store(
		g: StoredGame,
		prof: ReturnType<typeof qualifyStored>,
		kept: Record<Colour, boolean>
	): void {
		if (!prof) return;
		const tg = timingGame(g, prof.san.length, kept);
		this.pendingGames.push(`${JSON.stringify(tg)}\n`);
		this.pendingMoves.push(`${JSON.stringify(movesRecord(tg, prof))}\n`);
		this.moveUuids.add(g.uuid);
	}

	async seed(): Promise<void> {
		if (this.seeded) return;
		const lb = ((await this.http.get(`${API}/leaderboards`)) ?? {}) as Record<
			string,
			Array<{ username?: string; score?: number }>
		>;
		for (const [board, tc] of Object.entries(LEADERBOARDS)) {
			for (const p of lb[board] ?? []) if (p.username && p.score) this.note(p.username, tc, p.score);
		}
		for (const [title, guess] of Object.entries(TITLES)) {
			const res = (await this.http.get(`${API}/titled/${title}`)) as { players?: string[] } | null;
			const names = res?.players ?? [];
			for (const n of names) for (const tc of TIME_CLASSES) this.note(n, tc, guess);
			log(`seed ${title}: ${names.length} players`);
		}
		this.seeded = true;
		this.save();
	}

	/** Take the calibration corpus' qualifying games and file its players. */
	ingest(): void {
		if (this.ingested) return;
		const file = path.join(this.args.calib, "games.jsonl");
		let n = 0;
		let kept = 0;
		for (const g of jsonLines<StoredGame>(file)) {
			n++;
			this.note(g.white.username, g.time_class, g.white.rating);
			this.note(g.black.username, g.time_class, g.black.rating);
			if (this.ledger.seen(g.uuid, g.url)) continue;
			const prof = qualifyStored(g);
			if (!prof) continue;
			const k = this.ledger.admit(g, { w: true, b: true });
			if (!k) continue;
			this.store(g, prof, k);
			kept++;
		}
		this.flush();
		this.ingested = true;
		this.save();
		log(`ingested ${kept} of ${n} calibration games`);
	}

	/** Pop a random candidate for a cell, validated; null when the cell has none. */
	pop(cell: string): string | null {
		const list = this.candidates.get(cell);
		const set = this.inCell.get(cell);
		if (!list || !set) return null;
		const { tc } = parseCell(cell);
		while (list.length > 0) {
			const i = Math.floor(this.random() * list.length);
			const name = list[i] as string;
			list[i] = list[list.length - 1] as string;
			list.pop();
			set.delete(name);
			if (this.visited.has(name) || this.ledger.room(name, tc) <= 0) continue;
			return name;
		}
		return null;
	}

	/** One month of a visited player; returns kept sides gained per cell. */
	processMonth(
		body: unknown,
		player: string,
		monthsLeft: number,
		harvested: Map<string, number>
	): Map<string, number> {
		const gains = new Map<string, number>();
		/** Opponent sides still allowed this month per cell (the visit's harvest spread over its months). */
		const oppLeft = new Map<string, number>();
		const oppAllowed = (cell: string): number => {
			let n = oppLeft.get(cell);
			if (n === undefined) {
				n = monthQuota(this.args.harvest - (harvested.get(cell) ?? 0), monthsLeft);
				oppLeft.set(cell, n);
			}
			return n;
		};
		const raw = ((body as { games?: RawGame[] } | null)?.games ?? []).filter(prefilter);
		const quota: Record<TimeClass, number> = { bullet: 0, blitz: 0, rapid: 0 };
		for (const tc of TIME_CLASSES) quota[tc] = monthQuota(this.ledger.room(player, tc), monthsLeft);
		const taken: Record<TimeClass, number> = { bullet: 0, blitz: 0, rapid: 0 };
		for (const g of raw) {
			for (const s of [g.white, g.black]) {
				if (s?.username && Number(s.rating) > 0) this.note(s.username, g.time_class, Number(s.rating));
			}
		}
		for (const g of shuffle(raw, this.random)) {
			if (this.ledger.seen(g.uuid, g.url)) continue;
			const tc = g.time_class;
			const want: Record<Colour, boolean> = { w: false, b: false };
			let own: Colour | null = null;
			for (const colour of ["w", "b"] as const) {
				const s = colour === "w" ? g.white : g.black;
				const name = s?.username?.toLowerCase();
				const rating = Number(s?.rating);
				if (!name || !(rating > 0)) continue;
				const ok = this.ledger.eligible(name, tc, rating);
				if (name === player) {
					own = colour;
					want[colour] = ok && taken[tc] < quota[tc];
				} else {
					const band = bandFor(rating);
					want[colour] = ok && band !== null && oppAllowed(cellOf(tc, band)) > 0;
				}
			}
			if (!want.w && !want.b) continue;
			const q = qualifyArchive(g);
			if (!q) continue;
			const kept = this.ledger.admit(q.game, want);
			if (!kept) continue;
			if (own && kept[own]) taken[tc]++;
			this.store(q.game, q.prof, kept);
			for (const colour of ["w", "b"] as const) {
				if (!kept[colour]) continue;
				const band = bandFor((colour === "w" ? q.game.white : q.game.black).rating);
				if (band === null) continue;
				const c = cellOf(tc, band);
				gains.set(c, (gains.get(c) ?? 0) + 1);
				if (colour !== own) {
					oppLeft.set(c, (oppLeft.get(c) ?? 0) - 1);
					harvested.set(c, (harvested.get(c) ?? 0) + 1);
				}
			}
		}
		this.flush();
		return gains;
	}

	/** Visit a player picked for `cell`; returns kept sides gained per cell. */
	async visit(name: string, cell: string): Promise<{ gains: Map<string, number>; months: number }> {
		const gains = new Map<string, number>();
		const list = (await this.http.get(
			`${API}/player/${encodeURIComponent(name)}/games/archives`
		)) as { archives?: string[] } | null;
		this.visited.add(name);
		const months = shuffle(
			(list?.archives ?? []).filter((u) => archiveMonth(u) !== null),
			this.random
		);
		const planned = Math.min(
			months.length,
			maxMonthsFor(parseCell(cell).band, this.args.scarceFrom, this.args.fewMonths)
		);
		let fetched = 0;
		const harvested = new Map<string, number>();
		for (let i = 0; i < planned; i++) {
			if (TIME_CLASSES.every((tc) => this.ledger.room(name, tc) <= 0)) break;
			const body = await this.http.get(months[i] as string);
			fetched++;
			for (const [c, n] of this.processMonth(body, name, planned - i, harvested)) {
				gains.set(c, (gains.get(c) ?? 0) + n);
			}
		}
		return { gains, months: fetched };
	}

	/** Cells still below target that the crawl can still work on. */
	openShort(): string[] {
		return ALL_CELLS.filter(
			(c) =>
				this.ledger.fill(c) < this.args.target &&
				!this.parked.has(c) &&
				(this.candidates.get(c)?.length ?? 0) > 0
		);
	}

	// ── reporting ────────────────────────────────────────────────────────────────────────────

	rateGamesPerHour(): number {
		const now = Date.now();
		this.history.push({ t: now, games: this.ledger.games });
		while (this.history.length > 2 && (this.history[0]?.t ?? now) < now - 3_600_000)
			this.history.shift();
		const first = this.history[0];
		if (!first || now - first.t < 60_000) return 0;
		return ((this.ledger.games - first.games) * 3_600_000) / (now - first.t);
	}

	report(state: string): void {
		const L = this.ledger;
		const rate = this.rateGamesPerHour();
		const requests = this.requestsBefore + this.http.net;
		const cells: Record<string, Record<string, { sides: number; fit: number; holdout: number }>> = {};
		for (const tc of TIME_CLASSES) {
			cells[tc] = {};
			for (const b of BANDS) {
				const c = cellOf(tc, b);
				(cells[tc] as Record<string, unknown>)[String(b)] = {
					sides: L.fill(c),
					fit: L.cellSplit.get(`${c}:fit`) ?? 0,
					holdout: L.cellSplit.get(`${c}:holdout`) ?? 0,
				};
			}
		}
		const rapid = [...L.rapidControls.entries()].sort((a, b) => b[1] - a[1]);
		const short = ALL_CELLS.filter((c) => L.fill(c) < this.args.target).map((c) => ({
			cell: c,
			sides: L.fill(c),
			candidates: this.candidates.get(c)?.length ?? 0,
			parked: this.parked.has(c),
		}));
		let fit = 0;
		let holdout = 0;
		for (const [k, n] of L.cellSplit) {
			if (k.endsWith(":fit")) fit += n;
			else holdout += n;
		}
		const avgLat = this.http.net > 0 ? this.http.latencyMsTotal / this.http.net : 0;
		const etaH = rate > 0 ? Math.max(0, this.args.goalGames - L.games) / rate : null;
		const summary = {
			updatedAt: new Date().toISOString(),
			state,
			config: { ...this.args, window: [MONTH_FIRST, MONTH_LAST] },
			totals: {
				games: L.games,
				keptSides: L.sides,
				keptSidesFit: fit,
				keptSidesHoldout: holdout,
				playersWithKeptSides: L.playerTotal.size,
				visitedPlayers: this.visited.size,
				visits: this.visitsBefore + this.visits,
				requestsNetworkTotal: requests,
				requestsNetworkThisRun: this.http.net,
				cacheHitsOwnThisRun: this.http.hitsOwn,
				cacheHitsCalibThisRun: this.http.hitsCalib,
				retriesThisRun: this.http.retries,
				avgLatencyMs: Math.round(avgLat),
				gamesPerHour: Math.round(rate),
				etaHoursToGoalGames: etaH === null ? null : Number(etaH.toFixed(2)),
			},
			cells,
			short,
			parked: [...this.parked],
			rapidControls: Object.fromEntries(rapid),
			candidates: Object.fromEntries(ALL_CELLS.map((c) => [c, this.candidates.get(c)?.length ?? 0])),
		};
		atomicWrite(this.paths.summary, `${JSON.stringify(summary, null, "\t")}\n`);

		const lines: string[] = [];
		lines.push("# Timing crawl — status", "");
		lines.push(`Updated ${summary.updatedAt} — **${state}**`, "");
		lines.push(
			`Games **${L.games.toLocaleString()}** / goal ${this.args.goalGames.toLocaleString()} · kept sides ${L.sides.toLocaleString()} (fit ${fit.toLocaleString()}, holdout ${holdout.toLocaleString()}) · players with kept sides ${L.playerTotal.size.toLocaleString()} · visited ${this.visited.size.toLocaleString()}`
		);
		lines.push(
			`Requests: ${requests.toLocaleString()} network total (this run ${this.http.net}, own-cache hits ${this.http.hitsOwn}, calibration-cache hits ${this.http.hitsCalib}, retries ${this.http.retries}), avg latency ${Math.round(avgLat)} ms`
		);
		lines.push(
			`Rate ≈ ${Math.round(rate).toLocaleString()} games/h (last hour) · ETA to game goal: ${etaH === null ? "n/a" : `${etaH.toFixed(1)} h`}`,
			""
		);
		lines.push(
			`Cells: kept game-sides per (time class, mover band). Target ${this.args.target} (✗ = below), cap ${this.args.cellCap}. Band 3200 = 3200+.`,
			""
		);
		lines.push("| band | bullet | blitz | rapid |", "|---:|---:|---:|---:|");
		for (const b of BANDS) {
			const row = TIME_CLASSES.map((tc) => {
				const c = cellOf(tc, b);
				const n = L.fill(c);
				return `${n.toLocaleString()}${n < this.args.target ? " ✗" : ""}${this.parked.has(c) ? " (parked)" : ""}`;
			});
			lines.push(`| ${b} | ${row.join(" | ")} |`);
		}
		lines.push("");
		lines.push(
			`Short cells: ${short.length}. Open-and-short with candidates: ${this.openShort().length}.`,
			""
		);
		lines.push(
			"Rapid controls (games): " +
				rapid
					.slice(0, 12)
					.map(([k, n]) => `${k} ${n}`)
					.join(", "),
			""
		);
		lines.push(
			"Definitions: a *kept side* counts toward its cell and its player's caps (≤ " +
				`${this.args.perPlayer} overall, ≤ ${this.args.perPlayerTc} per time class); a game is stored iff ≥ 1 side is kept ` +
				"(`whiteKept`/`blackKept`). Sides under 600 are never kept. See tools/timing-crawl/policy.ts."
		);
		atomicWrite(this.paths.status, `${lines.join("\n")}\n`);
	}
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.data, { recursive: true });
	const crawl = new Crawl(args);
	crawl.load();
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	await crawl.seed();
	crawl.ingest();
	crawl.report("running");
	let lastReport = Date.now();
	let lastSave = Date.now();
	let reason = "interrupted";
	while (!stopping) {
		if (crawl.http.exhausted) {
			reason = "request budget spent";
			break;
		}
		const L = crawl.ledger;
		if (L.games >= args.goalGames && crawl.openShort().length === 0) {
			reason = "game goal reached and every reachable cell at target";
			break;
		}
		let pick: { name: string; cell: string } | null = null;
		for (const cell of rankCells(L.cellFill, args.target, args.cellCap, crawl.parked, crawl.random)) {
			// Beyond the target, keep working only while the game goal is unmet.
			if (L.fill(cell) >= args.target && L.games >= args.goalGames) continue;
			const name = crawl.pop(cell);
			if (name) {
				pick = { name, cell };
				break;
			}
		}
		if (!pick) {
			reason = "frontier exhausted";
			break;
		}
		const req0 = crawl.http.net;
		try {
			const { gains, months } = await crawl.visit(pick.name, pick.cell);
			crawl.visits++;
			const focus = gains.get(pick.cell) ?? 0;
			const recent = crawl.stall.get(pick.cell) ?? [];
			recent.push({ gain: focus, requests: crawl.http.net - req0 });
			if (recent.length > args.stall) recent.shift();
			crawl.stall.set(pick.cell, recent);
			if (shouldPark(recent, args.stall, args.minYield)) {
				crawl.parked.add(pick.cell);
				log(
					`parked ${pick.cell}: last ${recent.length} focused visits yielded < ${args.minYield} side/request (fill ${L.fill(pick.cell)})`
				);
			}
			let total = 0;
			for (const n of gains.values()) total += n;
			log(
				`visit ${pick.name} for ${pick.cell} (${L.fill(pick.cell)}): ${months} months, +${total} sides (+${focus} focus), ${crawl.http.net - req0} req · games ${L.games}`
			);
		} catch (err) {
			if (err instanceof TransientError) {
				log(`${err.message}; requeueing ${pick.name} and pausing 5 min`);
				crawl.file(pick.cell, pick.name);
				crawl.visited.delete(pick.name);
				await Bun.sleep(300_000);
				continue;
			}
			throw err;
		}
		// Month archives parse to tens of MB; return the garbage now so the footprint stays flat.
		Bun.gc(true);
		const now = Date.now();
		if (now - lastSave > 60_000) {
			crawl.save();
			lastSave = now;
		}
		if (now - lastReport > args.reportEvery * 1000) {
			crawl.report("running");
			lastReport = now;
		}
	}
	crawl.save();
	crawl.report(`stopped: ${reason}`);
	log(`stopped: ${reason}; games ${crawl.ledger.games}, sides ${crawl.ledger.sides}`);
}

if (import.meta.main) {
	await main();
}
