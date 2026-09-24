/**
 * tools/timing-crawl/policy/ledger.ts — the caps and the cell fills: which sides are kept, and
 * the running counts `games.jsonl` is replayed into on start.
 */

import { splitFor } from "../../calibration/build-corpus";
import type { StoredGame, TimeClass } from "../../calibration/common";
import { ALL_CELLS, bandFor, type Colour, cellOf } from "./cells";

export interface Caps {
	perPlayer: number;
	perPlayerTc: number;
	cellCap: number;
}

export const DEFAULT_CAPS: Caps = { perPlayer: 150, perPlayerTc: 30, cellCap: 8000 };

export class Ledger {
	readonly cellFill = new Map<string, number>();
	readonly cellSplit = new Map<string, number>();
	readonly playerTotal = new Map<string, number>();
	readonly playerTc = new Map<string, number>();
	readonly rapidControls = new Map<string, number>();
	readonly uuids = new Set<string>();
	readonly urls = new Set<string>();
	games = 0;
	sides = 0;

	constructor(readonly caps: Caps) {
		for (const c of ALL_CELLS) this.cellFill.set(c, 0);
	}

	fill(cell: string): number {
		return this.cellFill.get(cell) ?? 0;
	}

	seen(uuid: string, url?: string): boolean {
		return this.uuids.has(uuid) || (url !== undefined && url !== "" && this.urls.has(url));
	}

	/** Room left for a player in a time class under both caps. */
	room(player: string, tc: TimeClass): number {
		const p = player.toLowerCase();
		const total = this.caps.perPlayer - (this.playerTotal.get(p) ?? 0);
		const inTc = this.caps.perPlayerTc - (this.playerTc.get(`${p}:${tc}`) ?? 0);
		return Math.max(0, Math.min(total, inTc));
	}

	cellOpen(tc: TimeClass, rating: number): boolean {
		const band = bandFor(rating);
		return band !== null && this.fill(cellOf(tc, band)) < this.caps.cellCap;
	}

	/** Whether a side would be kept right now (band, open cell, player room). */
	eligible(player: string, tc: TimeClass, rating: number): boolean {
		return this.cellOpen(tc, rating) && this.room(player, tc) > 0;
	}

	/**
	 * Record a stored game. `want` says which sides the caller asks to keep; each is re-checked for
	 * eligibility (and a player can never keep both sides of one game). Returns the kept flags, or
	 * null when nothing is kept (the game is then not stored) or the game is a duplicate.
	 */
	admit(g: StoredGame, want: Record<Colour, boolean>): Record<Colour, boolean> | null {
		if (this.seen(g.uuid, g.url)) return null;
		const tc = g.time_class;
		const w = want.w && this.eligible(g.white.username, tc, g.white.rating);
		let b = want.b && this.eligible(g.black.username, tc, g.black.rating);
		if (w && b && g.white.username.toLowerCase() === g.black.username.toLowerCase()) b = false;
		if (!w && !b) return null;
		const kept = { w, b };
		this.record(g, kept);
		return kept;
	}

	/** Book a game with fixed kept flags (used when replaying `games.jsonl` on load). */
	record(g: StoredGame, kept: Record<Colour, boolean>): void {
		this.uuids.add(g.uuid);
		if (g.url) this.urls.add(g.url);
		this.games++;
		if (g.time_class === "rapid") {
			this.rapidControls.set(g.time_control, (this.rapidControls.get(g.time_control) ?? 0) + 1);
		}
		for (const colour of ["w", "b"] as const) {
			if (!kept[colour]) continue;
			const side = colour === "w" ? g.white : g.black;
			const band = bandFor(side.rating);
			if (band === null) continue;
			const p = side.username.toLowerCase();
			const cell = cellOf(g.time_class, band);
			this.cellFill.set(cell, this.fill(cell) + 1);
			const sk = `${cell}:${splitFor(p)}`;
			this.cellSplit.set(sk, (this.cellSplit.get(sk) ?? 0) + 1);
			this.playerTotal.set(p, (this.playerTotal.get(p) ?? 0) + 1);
			const pk = `${p}:${g.time_class}`;
			this.playerTc.set(pk, (this.playerTc.get(pk) ?? 0) + 1);
			this.sides++;
		}
	}
}
