# False Brilliant: 16...Nxd4, game 180019136748

The user reported that Chess.com did not mark 16...Nxd4 Brilliant in Omer-Sarikaya–zurdo1969
(2026-09-16), while the extension did. No exact replacement Chess.com category was supplied.
The supplied PGN's malformed move numbers were normalized while preserving all 44 played plies.

## Reproduction and cause

The position before the move is:

`r3r1k1/ppq1bppp/2n2nb1/1Q1p4/3N1B2/1B5P/PPP1NPP1/R3R1K1 b - - 6 16`

The moving knight is not a sacrifice: Nxd4 followed by Nxd4 is a knight exchange. Instead,
`planBrilliant` found the attacked queen on c7 and called leaving it there an ignored-threat
sacrifice worth six pawns (queen lost minus the knight just captured). Its same-square material
search missed `16...Nxd4 17.Bxc7 Nxb5`: Black takes White's queen on a different square.

The existing PV-based illusion check only looked at the principal variation. A fresh full
Stockfish 19 search chose `16...Nxd4 17.Qxe8+ Nxe8 ...` as its main line, so the queen-taking
reply never reached that check. The old classifier reproduced **Brilliant** on this evidence.

The exact game, original verdict, full before/after frames and engine provenance are retained
in `test/fixtures/review/false-brilliant-180019136748.json`. The full NNUE engine ran with two
threads, 64 MiB hash, MultiPV 3, depth cap 18 and a 5,000 ms search cap, with game history.
The root completed depth 18; the following position completed depth 17. Root candidates were
Nxd4 (+536 cp), Qd7 (+15 cp), and Qc8 (0 cp), from Black's perspective.

## Fix

For an offer of a piece other than the mover, inspect the opponent's actual legal capture
branch directly. If an immediate **non-checking** countercapture on another square safely
recovers at least the captured material, exclude that offer. Recovery uses the existing legal
same-square exchange search, including recaptures and pins; it never assumes a capture's face
value is a permanent material gain. It shares the offered capture's node budget and abstains
when proof runs out. Other genuine offers in the position remain independently eligible.

Checking intermediate captures are deliberately left to the existing engine/PV gates. Their
check can postpone an attack on the recovering piece, which this short exchange search cannot
resolve. Applying the new rejection indiscriminately removed a known positive, Chessigma #39
(14.Ne5, Kxc7 Nxc6+); the focused regression preserves that tactical case. This is a conservative
material check, not a complete tactical search or an attempt to reproduce unpublished thresholds.

On the identical captured evidence, the fixed classifier returns **Great**, with zero loss and
no sacrifice offer. This is our resulting category, not a claimed verified Chess.com Great label.
The result no longer depends on whether the PV accepts the queen, plays the game's Nxd4 reply,
or is truncated after the root move. Maia selection, timing and review search limits are unchanged.

## Regression evidence

- Replayed the full submitted movetext to verify the exact FEN and move at ply 32.
- Tested the exact capture, PV-independent classification, safe versus losing countercaptures,
  checking intermediate captures and exhausted material-search budgets.
- 108 focused tests passed (62 Brilliant/classifier tests and 46 board-effects reporter tests).
  Typecheck, scoped Biome checks and diff whitespace checks passed.
- Re-scored the existing 300 original SF19 frames for Chessigma's 100 pinned positives:
  **94/100 before and after**, including the same Mate precedence. No engine frames or thresholds
  were changed for this comparison. Two additional calls among 170 unlabelled moves disappeared;
  those moves are not verified negatives, so this is not a precision estimate.

The production build and dist verification passed, regenerating `release/sliced-2.0.0.zip`
from the current checkout (including the existing timing and endgame-simplification edits).
No live Chrome game was used for this repair. The changes remain uncommitted and unpushed.
