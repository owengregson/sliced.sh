# Immediate board effects and 12...Qf6

## Effects delivery

Board effects now leave `BoardEffectsReporter.report()` before book lookups, review-job creation, or classification. Even a previously computed verdict travels separately. Later rating deliveries contain only the chip and cannot replay the earlier move's rays after another move has landed.

The page renderer treats an empty effects list with a badge as a badge-only update. It preserves the current arrows and their deduplication state, including reduced-motion mode. Empty arrival batches without a badge still advance the static layer normally.

Regression checks cover stalled book/review answers, cached ratings, immediate forced/checkmate ratings, interleaved moves with late badges, and reduced motion. Existing effect/rating switches and audio tests also pass.

## Qf6 reproduction

User-labelled negative: martidianos–zurdo1969, game 180027994972, 12...Qf6 (ply 24), reported as Great on Chess.com and Brilliant in the extension. The normalized full supplied game and a fresh full-network Stockfish 19 review are retained in `test/fixtures/review/false-brilliant-180027994972.json`.

The original classifier reproduces Brilliant: it treats Ne4 and Bf1 as ignored-threat sacrifices. Accepting either apparent offer fails tactically:

- 13.Qxe4 Qxf2+ 14.Kh1 Qg1#.
- 13.Kxf1 Qxf2#.

The root review completed depth 18 with Qf6 +806 cp, Bc4 +709 cp, and Ba6 +659 cp. Settings: two threads, 64 MiB hash, three PVs, depth cap 18, 5-second search cap, full game history. These are local engine scores, not Chess.com scores.

The new gate applies only to a quiet, non-capturing, non-promoting move whose apparent offers are all already-attacked pieces. It requires a winning non-sacrificing alternative (at least 0.9 on the reference expected-points scale) and a bounded legal proof that taking every offered piece permits a forced checking mate within two moves. A proven mate on the played root is exempt, preserving the existing forced-mate rules. Checking moves, capturing sacrifices, newly exposed pieces, and sacrifices required to save a position remain eligible for Brilliant.

The best move meeting this narrow tactical-threat rule receives Great. On the identical saved evidence, Qf6 changes from Brilliant to Great, independently of whether its PV accepts or declines the apparent offer. This is a local heuristic calibrated against the supplied label, not a reproduction of Chess.com's unpublished classifier.

## Validation

The existing 300-frame Chessigma replay retains the same 94/100 labelled positives passing the Brilliant gates. Three known positive controls are pinned in a focused fixture so a broader mating-threat rejection cannot silently remove a capturing sacrifice or the two mating sequences. The former Nxd4 countertrade regression also remains Great.

Focused engine, reporter, renderer, content relay, and game-session tests passed. Production build, typecheck, and package verification are checked separately. Native Chrome visual testing was not performed; changes remain uncommitted.
