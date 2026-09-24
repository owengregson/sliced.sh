"""The fast path of the think-time corpus (`build_corpus.py`): the book lookups, the PGN reader and
the per-ply labels, in python-chess. `build-corpus.ts` holds the same rules and documents them;
`verify-labels.ts` recomputes a sample with the shipped TypeScript and requires 0 mismatches.

The rule constants are duplicated from the shipped registry: `BOOK.maxPly` 30,
`BOOK.minWeightShare` 0.01, `BOOK.gmBookElo` 1800, `MAIA.eloMax` 3000, the phase thresholds in
`src/core/chess/phase.ts`, and the premove and low-clock limits in `common.ts`.
"""
