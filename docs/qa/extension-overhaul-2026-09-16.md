# Extension overhaul — 2026-09-16

The release ZIP was subsequently rebuilt with the
[review startup and delayed-metadata fixes](review-startup-2026-09-16.md). That report records
the current archive checksum and validation; the artifact figures below describe the original
overhaul build.

This integrates the existing Stockfish 19 migration and unfinished working-tree changes with
the review, selection, timing, executor, settings and packaging work requested on September 16.
The original source changes were snapshotted before editing. No stashes, divergent branches or
unpushed commits existed at intake; the work was uncommitted. Git object integrity passed.
Unused local forced-sound variants were preserved under ignored `.scratch/archived-assets/`.

## Behavior

- Brilliant detection uses legal sacrifice/exchange evidence, voluntariness, soundness,
  alternatives and complete full-network SF19 review frames. Review evidence is independent
  of strength-limited play. The identical-frame benchmark improves from 89 to 94 recognized
  pinned positives out of 100. Explicit local non-Brilliant labels produce 0/10 false Brilliant
  calls, with another 0/12 constructed controls. These small, selected sets do not establish
  population accuracy or Chess.com parity. [Review evidence](sf19-brilliant-review-2026-09-16.md).
- Below 2800, Maia verification samples independent proposals with replacement and only
  compares finite shallow evidence. Equal/missing evidence preserves the prior distribution;
  tie-band normalization preserves probability mass. On 223 held-out game positions, mean
  probability assigned to the human move increases 42.80% to 45.26%. Modal agreement is unchanged;
  the NLL improvement over the old verifier is uncertain. The upper 2800–3000 policy was not
  recalibrated from lower-rated data. [Methods, results and ideas](../research/maia-recognition-verification-2026-09-16.md).
- The reported 2450-versus-2200 losses prompted a separate strength audit. On 58 complete
  held-out positions rated 2300–2700, the new verifier differs from the Sep15 calibration by
  +1.59 cp mean loss (95% interval −0.58 to +4.55), with a +0.38 percentage-point severe-error
  increase. Most historical weakening precedes this verifier. An isolated policy/verifier
  quality gap remains against these humans; full-pipeline playing Elo is not established.
  A twelve-position runtime probe found almost complete shallow coverage when verification
  ran; missing whole frames bypass verification in both versions. Existing clock/context,
  ambiguity and form deductions, opponent matching, and the removed accuracy offset can change
  effective conditioning. No uncalibrated rating boost or deep-score fallback restoration was
  applied. [Paired strength audit](../research/strength-audit-2450-2026-09-16.md) and
  [runtime probe](../research/runtime-shallow-coverage-2450-2026-09-16.md).
- Learned elapsed-time predictions include execution. Fast and long tails retain feasible
  support; preparation, optional exploration and mandatory movement consume one original
  arrival-to-release deadline. Clock refreshes do not restart it, and lobby waiting is excluded
  from the first move. Late searches drop optional activity and report the physical overrun;
  that latency does not teach the model a slower natural pace. [Timing evidence](../research/timing-tails-2026-09-16.md).
- Review searches yield during foreground move preparation, then run through planned thinking
  and executor activity. Synchronous classification has its own input/deadline guard and yields
  between jobs. Valid completed iterations survive a preparation pause, and live feedback keeps
  its two-ply freshness limit rather than retaining an old-rating backlog. Cached/board-known
  feedback remains cheap; incomplete review evidence never borrows playing-engine scores.
  [Continuous-play latency fix](review-latency-2026-09-16.md).
- Actual travel and short waits protect input from synchronous classification. Promotion reserves
  the picker before the pawn drop, keeps auto-queen at its original deadline, and applies physical
  speed caps to urgent picker travel. Late geometry remains a measured overrun.
- The hand chooses coherent purposes, including preparation, inspection, comparison,
  verification, relation tracing and stillness. Purpose persists briefly while targets are
  regenerated from the current board. Short windows, pressure and premove readiness suppress
  optional movement. Queueable premoves precede optional holds. Preview reversal pauses are
  longer, but every action must fit the available budget. Elo mouse rates are explicit design
  hypotheses, not measured cursor statistics. [36-pattern bank and sources](../research/mouse-repertoire-2026-09-16.md).
- Settings use outcome-based categories and named choices with optional exact adjustment.
  Strength retains its main controls; the old accuracy offset is removed and normalized to
  neutral. One Game auto-play switch controls the current hand and saved next-game intent.
  Explicit debugger cancellation clears that intent; routine detach does not. Native radio
  keyboard behavior and disabled-theme colors are corrected. Preference writes compare fresh
  storage inside the shared write queue; pending command intent prevents older storage events
  from undoing the latest toggle or rearming the next game. Write failures keep the hand stopped
  until an explicit retry. Eight regressions cover these races, failures and unchanged writes.
- `blunder.mp3` and `mistake.mp3` have exchanged contents by renaming the files. Rating-to-name
  mappings remain semantic. Great still has its sound and Best remains silent.

## Package decision

Models remain bundled. Lossless model recompression and removal of unregistered packaged audio
save about 0.29% of the previous archive; they do not solve the roughly 300 MiB footprint.
Models occupy over 96% of the archive. Distillation, a shared timing backbone, selectively
validated quantization and user-owned offline packs are documented alternatives with their
validation costs. A CDN is not the only possible architecture, so no incomplete downloader or
invented Maia endpoint was shipped. Internal extension caches cannot promise survival after a
true uninstall. [Measured options and cache design](../research/bundled-assets-and-cache-2026-09-16.md).

## Validation boundaries

Validation uses the simulator, real SF19/ONNX offline runs, focused regressions and the repository
gate. The settings UI was also rendered in an isolated Codex browser fixture: dark/light timing
views, named-choice persistence, disabled checked thumb color, and 360px horizontal overflow.
The fixture logged no browser warnings/errors during these checks.

No further testing in the user's Chrome was performed after the instruction to stop. Native
extension behavior remains unverified. Distribution replays are regression evidence, not a
rating calibration or proof of human equivalence. Reproduction commands and dataset limitations
are linked in each research report.

## Final release

`bun run check` passes: **3,292 tests across 337 files, zero failures**, including the final
review, promotion and strength-audit regressions. Lint, constants checks and TypeScript pass.

`bun run build` passes, including typecheck, CSS checks, asset verification and packaging.
The final `release/sliced-2.0.0.zip` is **315,481,406 bytes (300.8665 MiB)** with 84 files.
SHA-256: `3363af00aaf9acdd7953e2eefb61cfbac12a569d50bbc8484809830bb3499482`.

ZIP CRC validation passes and every extracted file matches `dist/` by SHA-256. Content and
panel bundles are 117.9 KiB / 250 KiB and 251.9 KiB / 400 KiB respectively. The final archive
is 913,357 bytes smaller than the intake artifact, including all runtime and UI changes;
model payloads still account for 96.38%. The packaging report isolates packaging-only savings.

Audio checks confirm the source and packaged files have exchanged identities:

- `blunder.mp3`: `75aea8e1bdc48f13d2c3d223156a2560a137e4bcadec1afe339bb90eece91f3f`
- `mistake.mp3`: `6ea0f3e1d748ab184592338c673bf953873270492dabf65aaf73eb169e42b83f`

The offline motor conformance pool records 9.12% preview selection, the 30-game pool 11.53%,
and blitz 6.03%, against the unchanged 4–12% band. Bullet remains slightly below that band at
3.84%, with complexity/hold correlation 0.12; the speed suite records these statistical misses
while asserting its hard invariants. Passing tests do not erase these remaining distribution
limitations or turn the Elo cursor priors into fitted human measurements.
