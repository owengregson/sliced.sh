# Bot behavior corrections and panel review

The work started from `a6e4540` with a clean worktree. This report covers the gameplay,
engine, input, movement and panel corrections that followed.

## Repetition and premoves

Engine requests now carry validated move history, including restored SAN history when joining
an ongoing game. Cached evaluations distinguish repetition history and the fifty-move clock.
Selection rejects repeating lines when a searched alternative preserves the advantage, including
an opponent reply that could claim threefold. Unknown or incomplete history is not invented.

Safe recapture/trade premoves are attempted more often. Queued moves are checked against every
legal opponent reply: a move that stays legal after an unexpected reply must still be a safe
recapture. The site must have premoves enabled; dispatching a gesture is not proof it was queued.

## Time and opponent pressure

All timing heads now share an outer clock budget. A normal move may use up to four per-move
allocations, a long think up to six, further bounded by 12% of the remaining clock and the
existing emergency caps. Binding caps retain a continuous sampled spread. Instant-reaction
overflow is resampled instead of pinned to 250 ms; predicted replies use sampled physical
gesture time instead of all landing on one minimum. Setup and verification consume the
original move window, and shallow searches share one wall-clock search budget.

The opponent-clock policy runs after the model. Its urgency window is 12% of the starting
clock, bounded to 8–30 seconds. Three increments are added to the opponent's effective clock;
our relative clock also matters. The timing policy shortens discretionary thinking by up to
45% while preserving the gesture and hard caps. The selection policy favors evaluated forcing
moves within 35 centipawns of the best line and suppresses deliberate blunders under significant
pressure. Mate and repetition safeguards retain priority. These constants live in the timing
and strength registries; the learned model is unchanged.

## Controls and feedback

Space interrupts a scheduled thinking/hover phase and starts the existing move through the
verified execution path. It does not interrupt an already committed drag or submit a second
move. Bare Space remains available alongside global shortcuts; editable fields are ignored.
The hand must already be armed and the assistant enabled. Arming now maintains the page's native
focus/visibility state, including while another tab or window is active. Stop remains available
from the page keyboard while virtual mouse control is active. See
[focus and input recovery](focus-and-input-recovery.md) for the follow-up implementation and checks.

Automatic recommendation speech, successful-move sounds and successful-move notifications are
removed. Explicit speech and error feedback remain available.

The native pointer is hidden while the virtual cursor is visible. Page pointer events are
filtered against preannounced virtual events; physical movements do not reposition the virtual
hand. This controls the page event stream, not the operating system or browser chrome. Hover
pauses are stationary with sparse optional adjustments; pauses keep their elapsed duration even
when no pointer movement is emitted. See [pointer ownership QA](pointer-ownership.md) for
Chrome evidence, admission semantics and native hover limitations.

## UI review

The panel now has labeled navigation, a clear live-game status, visible keyboard guidance,
readable settings help, searchable settings and save-error rollback. The redesign uses the
existing vanilla stack, brand assets and shared tokens. The reproducible preview uses the real
views with a simulated extension boundary: `bun tools/panel-preview.ts`.

Browser captures cover all routes at 320, 360 and 480 pixels, plus light theme and settings
search. Generated evidence is under `build-logs/ui-review/`. Browser fixture checks do not
replace playing a live game with the extension reloaded.

The follow-up uses concise technical labels and a fixed evaluation chip on both players' turns,
including current ponder evaluation and a labelled last-evaluation fallback. Both strength sliders
end at 3650 and mark the shared 3200 network boundary. Higher targets automatically download and
verify the full network. Stockfish's native calibrated limiter ends at 3190; the product's 3650
endpoint requests unrestricted strength and removes deliberate move-selection mistakes.

Opponent turns now include variable bouts of cursor exploration across legal candidates for both
sides, separated by stationary pauses. Move/premove handoffs cancel and await that activity. See
[opponent exploration](opponent-exploration.md) for lifecycle and pointer continuity checks.

## Final validation

- `bun run check`: passed generation, constants, formatting/lint, TypeScript and 1,927 tests
  across 223 isolated test-file runs, with zero failures after the final follow-up corrections.
- `bun run build`: passed release build, CSS checks and distribution verification. The current
  unpacked extension is in `dist/`; `release/sliced-2.0.0.zip` contains 73 files (63.0 MiB).
  Archive CRC, root MV3 manifest/version and exact bundled-script equality with `dist/` passed.
- UI QC: 56 Chrome captures, with no horizontal overflow or unnamed visible buttons in the
  audited states. The panel lane also passed its final 219 panel/design tests.
- Pointer/focus: dedicated Chrome verification passed inactive-tab focus/visibility, event
  admission, physical-input blocking and restoration checks. Delayed acknowledgments and
  executor replacement are covered by stop/re-arm regressions.
- Engine: actual full-network download and SHA-256 checks passed; the full WASM completed an
  unrestricted depth-10 search. Stack regressions cover initial boot, game reset and search
  ordering, including a full-network target before the first position.
- Full live-game validation on chess.com and physical application switching have not been
  performed. The browser fixture checks the underlying input/focus mechanism.

The draw policy preserves a searched winning alternative when one exists; it cannot prevent
forced draws or recover unavailable history before attachment. Queuing also depends on the
site's premove setting. See [decision QA](bot-decision-corrections-2026-09-10.md),
[panel QC](panel-redesign-2026-09-10.md), and [pointer QA](pointer-ownership.md) for details.
