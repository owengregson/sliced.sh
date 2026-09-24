// tools/timing-crawl/policy.test.ts — the timing crawl's pure rules: bands, the window, clock
// completeness, caps and kept sides, cell priority, month rationing, the derived think times.
import { describe, expect, it } from "bun:test";
import { splitFor } from "../calibration/build-corpus";
import type { StoredGame } from "../calibration/common";
import {
	ALL_CELLS,
	archiveMonth,
	BANDS,
	bandFor,
	clockProfile,
	DEFAULT_CAPS,
	Ledger,
	maxMonthsFor,
	monthQuota,
	movesRecord,
	prefilter,
	qualifyArchive,
	qualifyStored,
	rankCells,
	rng,
	timingGame,
} from "./policy";

/** A PGN of `plies` half-moves (knights shuffling), every ply clocked unless `drop` names one. */
function pgn(plies: number, drop = -1): string {
	const cycle = ["Nf3", "Nf6", "Ng1", "Ng8"];
	const parts: string[] = [];
	let clk = 180;
	for (let i = 0; i < plies; i++) {
		if (i % 2 === 0) parts.push(`${i / 2 + 1}.`);
		else parts.push(`${(i - 1) / 2 + 1}...`);
		parts.push(cycle[i % 4] as string);
		if (i !== drop)
			parts.push(`{[%clk 0:0${Math.floor(clk / 60)}:${String(clk % 60).padStart(2, "0")}]}`);
		if (i % 2 === 1) clk -= 1;
	}
	return `[Event "Live Chess"]\n[TimeControl "180+2"]\n\n${parts.join(" ")} *`;
}

const MAY_2026 = Date.UTC(2026, 4, 10) / 1000;

function game(over: Partial<StoredGame> = {}, wr = 1500, br = 1500): StoredGame {
	return {
		uuid: over.uuid ?? `u${Math.random()}`,
		url: over.url ?? "",
		end_time: over.end_time ?? MAY_2026,
		time_control: "180+2",
		time_class: "blitz",
		white: { username: "Alice", rating: wr, result: "win" },
		black: { username: "Bob", rating: br, result: "resigned" },
		pgn: pgn(24),
		...over,
	};
}

describe("bands", () => {
	it("floors to 100s, folds 3200+, drops under 600", () => {
		expect(bandFor(599)).toBeNull();
		expect(bandFor(600)).toBe(600);
		expect(bandFor(1799)).toBe(1700);
		expect(bandFor(3199)).toBe(3100);
		expect(bandFor(3350)).toBe(3200);
		expect(BANDS.length).toBe(27);
		expect(ALL_CELLS.length).toBe(81);
	});
});

describe("window and filters", () => {
	it("archive months inside 2025/09 … 2026/08 only", () => {
		const u = (m: string) => `https://api.chess.com/pub/player/x/games/${m}`;
		expect(archiveMonth(u("2025/08"))).toBeNull();
		expect(archiveMonth(u("2025/09"))).toBe("2025/09");
		expect(archiveMonth(u("2026/08"))).toBe("2026/08");
		expect(archiveMonth(u("2026/09"))).toBeNull();
	});
	it("end_time is half-open on UTC month boundaries", () => {
		expect(qualifyStored(game({ end_time: Date.UTC(2025, 8, 1) / 1000 }))).not.toBeNull();
		expect(qualifyStored(game({ end_time: Date.UTC(2025, 8, 1) / 1000 - 1 }))).toBeNull();
		expect(qualifyStored(game({ end_time: Date.UTC(2026, 8, 1) / 1000 }))).toBeNull();
	});
	it("needs a clock on every ply and ≥ 20 plies", () => {
		expect(clockProfile(pgn(24))?.clockMs.length).toBe(24);
		expect(clockProfile(pgn(24, 7))).toBeNull();
		expect(qualifyStored(game({ pgn: pgn(19) }))).toBeNull();
		expect(qualifyStored(game({ pgn: pgn(20) }))).not.toBeNull();
		expect(qualifyStored(game({ pgn: pgn(30, 29) }))).toBeNull();
	});
	it("archive entries: rated standard live only", () => {
		const raw = {
			uuid: "a",
			url: "u",
			rules: "chess",
			rated: true,
			time_class: "bullet",
			time_control: "60",
			end_time: MAY_2026,
			white: { username: "A", rating: 1200, result: "win" },
			black: { username: "B", rating: 1210, result: "timeout" },
			pgn: pgn(22),
		};
		expect(prefilter(raw)).toBe(true);
		expect(qualifyArchive(raw)?.game.time_control).toBe("60");
		expect(prefilter({ ...raw, rules: "chess960" })).toBe(false);
		expect(prefilter({ ...raw, rated: false })).toBe(false);
		expect(prefilter({ ...raw, time_class: "daily" })).toBe(false);
		expect(qualifyArchive({ ...raw, black: { username: "B", result: "win" } })).toBeNull();
	});
});

describe("ledger caps and kept sides", () => {
	it("keeps both sides when eligible and counts cells, splits and players", () => {
		const L = new Ledger(DEFAULT_CAPS);
		const kept = L.admit(game({ uuid: "g1" }, 1510, 2230), { w: true, b: true });
		expect(kept).toEqual({ w: true, b: true });
		expect(L.fill("blitz:1500")).toBe(1);
		expect(L.fill("blitz:2200")).toBe(1);
		expect(L.cellSplit.get(`blitz:1500:${splitFor("alice")}`)).toBe(1);
		expect(L.admit(game({ uuid: "g1" }), { w: true, b: true })).toBeNull();
	});
	it("per time class cap binds before the overall cap, per player", () => {
		const L = new Ledger({ perPlayer: 5, perPlayerTc: 3, cellCap: 1000 });
		for (let i = 0; i < 3; i++) L.admit(game({ uuid: `b${i}` }), { w: true, b: true });
		expect(L.room("alice", "blitz")).toBe(0);
		expect(L.room("ALICE", "bullet")).toBe(2);
		// Alice is capped in blitz: only Bob's side (renamed opponent) can be kept.
		const g = game({ uuid: "b9", black: { username: "Carol", rating: 1500, result: "x" } });
		expect(L.admit(g, { w: true, b: true })).toEqual({ w: false, b: true });
		for (let i = 0; i < 2; i++)
			L.admit(game({ uuid: `c${i}`, time_class: "bullet" }), { w: true, b: false });
		expect(L.room("alice", "rapid")).toBe(0);
		expect(L.playerTotal.get("alice")).toBe(5);
	});
	it("a side not asked for or not eligible does not count; nothing kept → not stored", () => {
		const L = new Ledger(DEFAULT_CAPS);
		expect(L.admit(game({ uuid: "x" }, 1500, 550), { w: false, b: true })).toBeNull();
		expect(L.games).toBe(0);
		expect(L.admit(game({ uuid: "y" }, 1500, 550), { w: true, b: true })).toEqual({
			w: true,
			b: false,
		});
		expect(L.playerTotal.get("bob")).toBeUndefined();
	});
	it("closes a cell at the cap", () => {
		const L = new Ledger({ perPlayer: 150, perPlayerTc: 30, cellCap: 2 });
		L.admit(game({ uuid: "1" }), { w: true, b: true });
		expect(L.cellOpen("blitz", 1550)).toBe(false);
		expect(L.admit(game({ uuid: "2" }), { w: true, b: true })).toBeNull();
	});
	it("dedupes by url as well as uuid", () => {
		const L = new Ledger(DEFAULT_CAPS);
		L.admit(game({ uuid: "1", url: "https://x/1" }), { w: true, b: true });
		expect(L.admit(game({ uuid: "2", url: "https://x/1" }), { w: true, b: true })).toBeNull();
	});
});

describe("priority and rationing", () => {
	it("ranks the least-filled open, unparked cells first", () => {
		const fills = new Map(ALL_CELLS.map((c) => [c, 100]));
		fills.set("bullet:2800", 0);
		fills.set("rapid:1200", 50);
		fills.set("blitz:900", 9999);
		const order = rankCells(fills, 4000, 8000, new Set(["rapid:1200"]), rng(1));
		expect(order[0]).toBe("bullet:2800");
		expect(order).not.toContain("rapid:1200");
		expect(order).not.toContain("blitz:900");
		expect(order.length).toBe(79);
	});
	it("spreads a player's room over the months left", () => {
		expect(monthQuota(30, 3)).toBe(10);
		expect(monthQuota(25, 3)).toBe(9);
		expect(monthQuota(4, 12)).toBe(1);
		expect(monthQuota(0, 2)).toBe(0);
		expect(monthQuota(7, 0)).toBe(7);
		expect(maxMonthsFor(2400)).toBe(12);
		expect(maxMonthsFor(1200)).toBe(3);
	});
});

describe("derived moves record", () => {
	it("think = previous own clock (base first) − clock + increment", () => {
		const g = game({ uuid: "m" });
		const prof = qualifyStored(g);
		if (!prof) throw new Error("fixture must qualify");
		const rec = movesRecord(timingGame(g, prof.san.length, { w: true, b: false }), prof);
		expect(rec.baseMs).toBe(180_000);
		expect(rec.incMs).toBe(2000);
		// Ply 0: 180 s → clock 180 s → think 2 s; ply 2: 180 → 179 → 3 s.
		expect(rec.thinkMs.slice(0, 4)).toEqual([2000, 2000, 3000, 3000]);
		expect(rec.san.length).toBe(24);
		expect(rec.whiteKept && !rec.blackKept).toBe(true);
	});
	it("records the split of each player as build-corpus defines it", () => {
		const g = game();
		const t = timingGame(g, 24, { w: true, b: true });
		expect(t.whiteSplit).toBe(splitFor("Alice"));
		expect(t.blackSplit).toBe(splitFor("bob"));
	});
});
