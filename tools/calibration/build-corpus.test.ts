// tools/calibration/build-corpus.test.ts — the chess.com corpus builder's pure helpers on an
// inline PGN: clock parsing, increment in thinkMs, promotion UCI, the history window, the split.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import {
	historyWindow,
	MIN_PLY,
	parseClockMs,
	parsePgn,
	replaySans,
	rowsForSample,
	splitFor,
	toUci,
} from "./build-corpus";
import { bucketFor, parseTimeControl, timeClassFor } from "./common";

// 3+2. Knights shuffle home (8 plies), then White's pawn runs to a8 and promotes on ply 16.
const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "Alpha"]
[Black "Beta"]
[Result "*"]
[WhiteElo "1210"]
[BlackElo "1190"]
[TimeControl "180+2"]

1. Nf3 {[%clk 0:03:01]} 1... Nf6 {[%clk 0:03:01.5]} 2. Nc3 {[%clk 0:03:00]} 2... Nc6 {[%clk 0:03:01]}
3. Ng1 {[%clk 0:02:59.5]} 3... Ng8 {[%clk 0:03:00]} 4. Nb1 {[%clk 0:02:58]} 4... Nb8 {[%clk 0:02:59]}
5. e4 {[%clk 0:02:57]} 5... d5 {[%clk 0:02:58]} 6. exd5 {[%clk 0:02:56]} 6... c6 {[%clk 0:02:57]}
7. dxc6 {[%clk 0:02:55]} 7... Nf6 {[%clk 0:02:56]} 8. cxb7 {[%clk 0:02:54]} 8... Nbd7 {[%clk 0:02:55]}
9. bxa8=Q {[%clk 0:02:50.2]} 9... Qb6 {[%clk 0:02:40]} 10. Qxa7 {[%clk 0:02:48]} 10... Qxa7 {[%clk 0:02:38]} *`;

const CTX = {
	uuid: "u-1",
	tc: "blitz" as const,
	bucket: 1200,
	selfElo: 1210,
	oppoElo: 1190,
	timeControl: "180+2",
};

describe("clock parsing", () => {
	it("reads H:MM:SS.s, H:MM:SS, M:SS and seconds", () => {
		expect(parseClockMs("0:02:59.9")).toBe(179_900);
		expect(parseClockMs("0:03:00")).toBe(180_000);
		expect(parseClockMs("1:00:00")).toBe(3_600_000);
		expect(parseClockMs("2:05")).toBe(125_000);
		expect(parseClockMs("0:00:00.3")).toBe(300);
		expect(parseClockMs("5.25")).toBe(5_250);
		expect(parseClockMs("x:10")).toBeNull();
	});

	it("attaches one clock per ply", () => {
		const p = parsePgn(PGN);
		expect(p.headers.TimeControl).toBe("180+2");
		expect(p.sans.length).toBe(20);
		expect(p.clocksMs.length).toBe(20);
		expect(p.clocksMs[0]).toBe(181_000);
		expect(p.clocksMs[16]).toBe(170_200);
		expect(p.sans[16]).toBe("bxa8=Q");
	});
});

describe("uci and replay", () => {
	it("lowercases the promotion suffix", () => {
		expect(toUci({ from: "b7", to: "a8", promotion: "Q" })).toBe("b7a8q");
		expect(toUci({ from: "e2", to: "e4" })).toBe("e2e4");
	});

	it("replays SAN to FENs and UCI", () => {
		const g = replaySans(parsePgn(PGN).sans);
		expect(g.fens.length).toBe(21);
		expect(g.fens[0]).toBe(new Chess().fen());
		expect(g.ucis[16]).toBe("b7a8q");
		expect(g.ucis[17]).toBe("d8b6");
	});

	it("history is the last ≤ 8 positions ending with the current one", () => {
		const g = replaySans(parsePgn(PGN).sans);
		const early = historyWindow(g.fens, 3);
		expect(early).toEqual(g.fens.slice(0, 4));
		const late = historyWindow(g.fens, 16);
		expect(late.length).toBe(8);
		expect(late[0]).toBe(g.fens[9] as string);
		expect(late[7]).toBe(g.fens[16] as string);
	});
});

describe("rows", () => {
	it("white: own moves from ply 16, clocks before the move, think with increment", () => {
		const rows = rowsForSample(PGN, { ...CTX, side: "w", player: "alpha" });
		expect(rows.map((r) => r.ply)).toEqual([16, 18]);
		const r = rows[0];
		if (!r) throw new Error("no row");
		expect(r.id).toBe("u-1:16");
		expect(r.humanMove).toBe("b7a8q");
		expect(r.clockMs).toBe(174_000);
		expect(r.oppClockMs).toBe(175_000);
		expect(r.thinkMs).toBe(174_000 - 170_200 + 2_000);
		expect(r.baseMs).toBe(180_000);
		expect(r.incrementMs).toBe(2_000);
		expect(r.lastMove).toBe("b8d7");
		expect(r.prevOwnMove).toBe("c6b7");
		expect(r.historyFens.length).toBe(8);
		expect(r.historyFens[7]).toBe(r.fen);
		expect(r.color).toBe("w");
		expect(r.moveNumberInGame).toBe(9);
		expect(r.split).toBe(splitFor("alpha"));
		expect(rows[1]?.thinkMs).toBe(170_200 - 168_000 + 2_000);
	});

	it("black: rows start at ply 17", () => {
		const rows = rowsForSample(PGN, { ...CTX, side: "b", player: "beta" });
		expect(rows.map((r) => r.ply)).toEqual([17, 19]);
		expect(rows[0]?.humanMove).toBe("d8b6");
		expect(rows[0]?.clockMs).toBe(175_000);
		expect(rows[0]?.oppClockMs).toBe(170_200);
		expect(rows[0]?.thinkMs).toBe(175_000 - 160_000 + 2_000);
		expect(rows[1]?.humanMove).toBe("b6a7");
		expect(rows.every((r) => r.ply >= MIN_PLY)).toBe(true);
	});
});

describe("split", () => {
	it("is deterministic, case-insensitive and follows the sha1 byte", () => {
		for (const name of ["alpha", "beta", "hikaru", "some_player_42"]) {
			const byte = createHash("sha1").update(`calib:${name}`).digest()[0] ?? 0;
			expect(splitFor(name)).toBe(byte < 154 ? "fit" : "holdout");
			expect(splitFor(name.toUpperCase())).toBe(splitFor(name));
		}
		let fit = 0;
		for (let i = 0; i < 2000; i++) if (splitFor(`p${i}`) === "fit") fit++;
		expect(fit / 2000).toBeGreaterThan(0.55);
		expect(fit / 2000).toBeLessThan(0.65);
	});
});

describe("common", () => {
	it("buckets and time classes", () => {
		expect(bucketFor(600)).toBe(600);
		expect(bucketFor(699)).toBe(600);
		expect(bucketFor(501)).toBe(600);
		expect(bucketFor(450)).toBeNull();
		expect(bucketFor(3100)).toBe(3000);
		expect(bucketFor(3101)).toBeNull();
		expect(parseTimeControl("180+2")).toEqual({ baseS: 180, incS: 2 });
		expect(parseTimeControl("1/86400")).toBeNull();
		expect(timeClassFor(60, 0)).toBe("bullet");
		expect(timeClassFor(120, 1)).toBe("bullet");
		expect(timeClassFor(180, 0)).toBe("blitz");
		expect(timeClassFor(300, 5)).toBe("blitz");
		expect(timeClassFor(600, 0)).toBe("rapid");
	});
});
