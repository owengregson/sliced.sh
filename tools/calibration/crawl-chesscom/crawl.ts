/**
 * tools/calibration/crawl-chesscom/crawl.ts — the crawl's state and policy: every player seen, filed
 * under the cell of each last-seen rating; the next visit (a random unvisited player from the
 * least-filled cell that still has one); the samples taken from accepted games (≤ `perPlayer` per
 * player per cell, `target` per cell); and its persistence in `crawl-state.json`, `samples.jsonl`
 * and `games.jsonl`, so a crawl resumes where it stopped.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mulberry32 } from "../../lib/random";
import {
	BUCKETS,
	bucketFor,
	cellKey,
	PATHS,
	type Sample,
	type StoredGame,
	TIME_CLASSES,
	type TimeClass,
} from "../common";
import { type ArchiveGame, acceptGame, isTimeClass } from "./archive";
import type { CrawlArgs } from "./args";
import type { Http } from "./http";

export type Ratings = Partial<Record<TimeClass, number>> & { guess?: boolean };

interface PersistedState {
	visited: string[];
	players: Record<string, Ratings>;
	requestsTotal: number;
	seeded: boolean;
}

export class Crawl {
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
		readonly args: CrawlArgs,
		readonly http: Http
	) {
		this.random = mulberry32(args.seed);
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
