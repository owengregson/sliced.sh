# Blunder margins and move-log styling — 2026-09-16

The owner's supplied move log contains five bot Blunders that they report Chess.com did not classify as Blunders. The HTML contains the bot's categories, not Chess.com's replacement categories or engine scores.

Chess.com [publishes expected-points loss bands](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc), including a 0.20 Blunder boundary, but does not publish the fitted rating/evaluation formula there. Our local logistic approximation multiplied its slope by 1.475 at 2450 Elo, amplifying losses around equality. Applying the published boundary directly to that approximation was too aggressive.

The classifier now requires both the existing rated loss of at least 0.20 and a reference-curve loss of at least 0.30 to call an ordinary move a Blunder. Otherwise it remains a Mistake. This is a conservative local margin, not a reconstructed Chess.com formula. Other ordinary bands, special categories, measured loss diagnostics, engine settings and move selection are unchanged.

Replayed the supplied 96-ply game and collected 15 neighboring positions using the shipped Stockfish 19 full NNUE, unrestricted strength, two threads, 64 MB hash, MultiPV 3, depth 18 / five seconds per position. All frames are complete, at depth 17–18. The fixture preserves the game, actual engine frames and provenance. A played root already present in the before frame uses that score, consistently with production.

| Move | Best → played evaluation, mover's view | Old classifier, fresh evidence | New classifier |
| --- | --- | --- | --- |
| 13...Rg8 | +1.37 → −1.11 | Blunder | Mistake |
| 17.Rf2 | +2.02 → −1.19 | Blunder | Mistake |
| 23...Bc5 | +3.24 → +1.35 | Mistake | Mistake |
| 26.Ne4 | −0.50 → −5.24 | Blunder | Blunder |
| 41.Kf2 | −0.24 → −2.89 | Blunder | Mistake |

Four of the five reported Blunders therefore become Mistakes with fresh evidence and the margin; Bc5 already changed under fresh analysis alone. Ne4 remains a discrepancy with the owner's reported Chess.com result. Its large evaluated loss is not suppressed merely to fit this game. One reported game cannot establish general precision or Chess.com parity.

Move-log badges now use `margin-bottom: 2.5px; margin-left: 2px; margin-right: 0px`. Text color fades in 320 ms instead of 160 ms (half the speed); the badge retains its shared 200 ms canvas entrance and reduced-motion handling.

Validation: 50 tests across grading, reference probabilities, review evidence, the previous countertrade regression and move-log rendering; another 91 tests across Brilliant gates, the review reporter, live rating delivery and content relay. Tests include the five replayed positions, loss-diagnostic preservation, margin boundaries, positive Blunder controls across ratings, and allowing forced mate. Focused lint and whitespace checks pass. Native Chrome live-game validation was not performed. Changes remain uncommitted.

Production build passes TypeScript, generated-page/CSS/constants checks and distribution verification. `release/sliced-2.0.0.zip` contains 84 files (300.9 MiB); `unzip -t` reports no errors.
