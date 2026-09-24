# Endgame tablebases — 2026-09-23

Owner: positions with ≤ 7 men (kings included) should be playable perfectly from endgame
tablebases; at max rating always, rated **Book** on the board; at human ratings only as often as
real players of that rating would effectively play the perfect move.

## Design decision: where the tables come from

| Option | Verdict |
|---|---|
| Ship Syzygy files | **Rejected.** 3–5 men are ≈ 939 MB (WDL + DTZ), 6 men ≈ 150 GB, 7 men ≈ 17–18 TB. The whole package is ≈ 250–320 MB today (`package-size-2026-09-13.md`). A 3–4-man subset (a few MB) would cover almost nothing the engine does not already play perfectly, and needs a Syzygy prober ported to TypeScript. |
| Stockfish's own Syzygy support | **Rejected.** The vendored `sf_19_*` wasm carries the `SyzygyPath` options, but the `@lichess-org/stockfish-web` glue is built without an Emscripten filesystem (no `FS`, only `setNnueBuffer`), so the probe code can never open a table. It would mean rebuilding the GPL engine with a filesystem, and still shipping the files. |
| **Lichess tablebase API** (`tablebase.lichess.ovh/standard`) | **Chosen.** Syzygy 7-man WDL/DTZ plus DTM for ≤ 5 men, free, answers in ≈ 50–300 ms, and sends `Access-Control-Allow-Origin: *`. |

### How the API is used (C7, §13.3)

- **Service worker only.** `TABLEBASE_ENDPOINT` is a separate top-level export in
  `src/core/constants/tablebase.ts` (not a `URLS` member, so no other bundle inlines it), and
  `scripts/verify-dist.ts`'s `HOST_OWNERS` allows `tablebase.lichess.ovh` in
  `js/service-worker.js` alone. Nothing reaches the page realm; chess.com cannot observe a request
  the extension's worker makes to another origin.
- **No host permission.** The server's CORS header lets the worker's plain CORS fetch through (also
  under the manifest's COEP), and adding a host permission would disable the extension on update
  until the user re-approved it.
- **The request carries a FEN with the counters zeroed and nothing else** (`credentials: "omit"`).
  A strength setting, *Endgame tablebase* (on by default), turns probing off entirely, and the
  human policy draws *before* probing, so a position the bot would not play from the tables never
  leaves the browser.
- **Robustness** (`src/core/tablebase/client.ts`): LRU cache of 512 positions keyed without the
  counters; concurrent probes share one request; 2 s request timeout; ≥ 250 ms between requests; an
  HTTP 429 silences the client for 60 s; 3 consecutive failures (offline, 5xx, malformed) for
  2 min. Every failure means "the engine plays", never an error.
- **Timing** (`recommendation.ts`): the probe starts with the engine search and is awaited only
  until the move's preparation deadline. At max strength outside a clock race the floor is 600 ms
  from the start of preparation (the answer normally lands long before the search ends anyway).
  The engine search still runs in full: the timing model's features read its MultiPV lines, so the
  human timing distribution does not change when the tables answer (C7). Book-speed timing is
  **not** applied to tablebase moves — a person thinks in an endgame.

### Perfect play from an answer (`src/core/tablebase/rank.ts`)

The tables know nothing of the game, so the game's own facts are applied on top:

- **50-move rule** with the true half-move clock (from the replayed history, compared by position
  so a DOM-read FEN with heuristic counters still gets the real clock): a win whose next zeroing
  move lands after the rule is a *cursed win* (a draw on chess.com, which applies the rule
  automatically); a loss the opponent cannot convert in time is a *blessed loss* (a draw for us). A
  rounded Syzygy DTZ keeps one ply of margin, as Stockfish's `root_probe` does.
- **Threefold repetition**: a move completing one is a draw whatever the table says.
- **Legality**: only moves legal on the board are ranked; an answer with none is ignored.

Ordering, Syzygy semantics: **win** → checkmate, then the fastest conversion (plies to the next
zeroing move counted from the root, 1 for a capture/pawn move), then the shortest DTM when known,
avoiding a repeat; **draw / cursed win / blessed loss** → any result-keeping move, the engine's
preference decides (it keeps practical chances); **loss** → the longest resistance (latest zeroing
move, then longest mate).

### Max strength

`isMaxStrength` → probability 1: whenever the position is in range and an answer arrives, it is
played. The max-strength deep search is skipped for a tablebase move (no search improves on the
tables); the move still lands on the timing plan's own deadline. Without an answer the max-strength
engine path is unchanged.

### Book rating

`RecommendationOutcome.fromTablebase` → `BoardEffectsReporter.prepare({ tablebase: true })` →
the verdict is `tablebaseMoveVerdict()` (quality `book`) the moment the move lands, with no review
frame needed. The one exception is a checkmating move, which keeps its `mate` chip (the final move
of the game always sounds the top step). Only our own tablebase moves are Book; the opponent's
moves are reviewed as before. The panel labels the recommendation "Tablebase move".

## Human ratings: evidence and policy

### Measurement

`tools/tablebase-human/measure.py` walks real games, and at every position with ≤ 5 men (no
castling rights) probes the full local Syzygy 3-4-5 set (WDL + DTZ, 939 MB, `tablebase.sesse.net`
mirror; python-chess) for **every** legal move, then records the mover's rating, the time control,
whether the played move was **optimal** (in the best tier under the same semantics as
`rank.ts`: for a win the fastest conversion, for a loss the longest resistance, for a draw any
drawing move) and whether it **kept the result** (did not turn a win into a draw/loss or a draw into
a loss). `analyze.py` produces the tables. Only *decisions* count — positions where not every legal
move is equally good; "result kept" counts only positions where some legal move throws the result.
"Random" is the optimal rate a uniformly random legal move would reach.

Sources (games scanned up to the time budget, then stopped):

| Source | Players | Positions (decisions) |
|---|---|---:|
| Lichess open database, 2014-03 (rated, all speeds) | 800–2400 Lichess | ≈ 110 k |
| Lichess Elite database, 2020-06 (≥ 2400 vs ≥ 2200 online, mostly blitz) | 2000–2900 Lichess | ≈ 114 k |
| The Week in Chess 1540–1560 (over the board, FIDE-rated events) | 1200–2800 FIDE | ≈ 126 k |

### Results (≈ 350 k decisions)

| Rating | n | optimal | random | result kept (per move) |
|---|---:|---:|---:|---:|
| < 1200 | 2,052 | 55.5 % | 28.3 % | 92.8 % |
| 1200–1599 | 50,385 | 62.3 % | 30.6 % | 94.1 % |
| 1600–1999 | 67,563 | 68.3 % | 33.4 % | 96.0 % |
| 2000–2399 | 109,997 | 74.8 % | 38.8 % | 97.1 % |
| 2400–2699 | 115,424 | 72.6 % | 36.2 % | 96.4 % |
| 2700+ | 5,066 | 81.5 % | 41.8 % | 97.9 % |

By venue (optimal / kept): online blitz 2400–2699 69.0 % / 95.4 %, 2700+ 72.6 % / 96.8 %; over the
board 2000–2399 77.4 % / 97.8 %, 2400–2699 82.0 % / 98.4 %, 2700+ 86.3 % / 98.4 %. Bullet is worst
at every level (1600–1999: 58.9 % / 93.6 %). Lichess ratings run above FIDE; chess.com's sit between.

By theoretical result (the telling split): in **won** positions the fastest conversion is found
only 49–65 % of the time at every level (random: 12–15 %), yet the win is kept on 94–97 % of moves;
in **drawn** positions the draw is kept 89 % (< 1200) → 97 % (2000+) → 99 % (2700+); in **lost**
positions nobody resists DTZ-optimally (≈ 56 % at every level against 40–47 % random). Men: 3–4 vs 5
men barely changes the optimal rate, but the result-throwing rate rises with material at every
rating (2000–2399: 98.4 % kept with 3–4 men, 96.1 % with 5).

Game level (first ≤ 5-man position of each side): a theoretically **won** position was converted in
62 % (< 1200), 79 % (1200–1599), 84 % (1600–1999), 88 % (2000–2399), 83 % (2400–2699, mostly blitz),
87 % (2700+) of games; a **drawn** one held (not lost) in 76 % → 79 % → 85 % → 88 % → 87 % → 93 %.
Online results include flag falls.

Literature points the same way: Guid, Možina, Sadikov and Bratko had to derive human-usable
strategies from the KBNK and KRK tables precisely because tablebase play is not how strong players
play or explain these endings (*Deriving Concepts and Strategies from Chess Tablebases*, ACG 2009 —
<https://link.springer.com/chapter/10.1007/978-3-642-12993-3_18>), and KBNK is known to defeat even
titled players inside the 50-move limit (<https://chessprogramming.org/KBNK_Endgame>).

### Decision

No human rating plays tablebase chess: even 2700+ over the board is 86 % optimal and loses the
result on ≈ 1.6 % of risky moves; club players find the fastest win only about 60 % of the time. The
human policy (Maia through 3000, the engine above) already produces a human endgame, so the tables
are allowed only a small *addition*: the replacement probability is set so that, if the base policy
already matched the measured human rate `r(E)`, the tables would lift it by about four points —
`q ≈ 0.04 / (1 − r(E))`.

| | Value | From |
|---|---|---|
| `TABLEBASE_HUMAN.floorElo` | 1600 | Below it never: 55–62 % optimal and 6–7 % result-throwing is what those players do. |
| `floorProb` at 1600 | 0.10 | r ≈ 0.66 (online 1600–1999) → 0.04 / 0.34 ≈ 0.12, rounded down. |
| `maxProb` at `fullElo` 2800 | 0.30 | r ≈ 0.73 (online 2700+) … 0.86 (OTB 2700+) → 0.15 … 0.29. |
| 3000 → 3800 | 0.30 → 1 | Above the Maia ceiling the full engine plays already; max strength is perfect play. |
| 6–7 men | × 0.5 | Unmeasured (no local 6–7-man tables); errors grow with material, and those wins are the least human-findable. |

The draw is one per move, made before any request, from the game's seeded rng.

## Limitations

- Needs the network and a public service; offline or rate-limited, the engine plays (as before).
- Premoves at max strength are still decided by the premove rule (only-legal move or a proven-safe
  recapture), not by the tables.
- The human policy draws per move, independently; a real player's knowledge of a given ending is
  more persistent than that.
- The API's 7-man tables are Syzygy (DTZ, not DTM) above 5 men: conversions are DTZ-optimal, which
  can look unnatural to a human watching (it always heads for the next capture or pawn move).
