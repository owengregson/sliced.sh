# Endgame simplification preference

The request was to modestly favor trading opposing pieces away when a material advantage makes
the remaining endgame easier to convert.

## Investigation

Maia-3 predicts human moves from training games ([official project](https://github.com/CSSLab/maia3)).
It can learn simplification implicitly; that is not an explicit guarantee for each position.
The checkout already had a 1.8× immediate-trade heuristic when ahead by 300 cp. It reached base
sampling and the plain Maia draw's near-equal tie band, but generate-and-verify skipped it.
The old detector did not require a material advantage or check the exchange's resulting board.

Direct queries of the shipped 79M ONNX model, using a single FEN and equal self/opponent ratings:

| Position | Move | Maia at 1500 | Maia at 2400 |
| --- | --- | ---: | ---: |
| `8/8/4k3/3r4/8/8/PP6/3RK3 w - - 0 40` | Rxd5 (`d1d5`) | 96.53% | 99.20% |
| `7k/8/8/8/r7/4K3/PP6/3R4 w - - 0 40` | Rd4 (`d1d4`), offering Rxd4 Kxd4 | 0.251% | 0.115% |

These are small illustrative probes, not calibration evidence. In the second position Maia
preferred a3, attacking the rook. They demonstrate why the new preference should preserve the
model's existing ranking and should not force a trade offer. The selector still requires a
searched PV and a retained evaluation; these model probes alone do not establish move quality.

## Behavior

`simplificationFactors` recognizes a two-ply piece capture/recapture or a three-ply offer/capture/
recapture on the offered square. It requires an endgame, at least one pawn of material advantage,
best evaluation above +250 cp, and a candidate retaining at least +250 cp. It uses unclipped cp.
The completed exchange must retain the material lead and must not produce a drawn board.
Pawn-only exchanges, incomplete/illegal continuations, missing/bounded scores and positions with
a searched positive mate receive no bonus.

The factor is `1 + 0.25 × advantage × quality × removal`:

- Advantage ramps from zero at +250 cp to full at +500 cp.
- Quality falls from full at zero loss to zero at 75 cp loss.
- Removal is the fraction of opposing non-pawn material exchanged away.

The maximum 1.25× factor changes equal proposal weights from 50/50 to 55.56/44.44. It does not
add centipawns, force a move, add an unsearched move, or bypass existing safety filters.

Both ordinary and upper Maia verification apply the factor to proposal mass. The plain draw
applies it once after its existing tie-band terms; the prior's copy is removed from that tie
calculation. Original Maia probabilities and ranks remain intact, and KL accounting includes
the preference. The non-Maia sampling prior replaces its old endgame 1.8× trade term with this
factor (subject to the existing prior exponent). The old non-endgame trade term remains.
Native engine selection and the full-strength path above 3000 are unchanged.

## Validation

Focused tests cover white/black exchanges, quiet offers, partial liquidation, evaluation taper,
material equality/deficit, sacrifices, dead positions, pawn trades, illegal PVs, missing/bounded
scores, unclipped evaluation loss, searched mates, all Maia selection branches, original-policy
telemetry, non-Maia sampling, double-count prevention and full-strength selection.

Existing Maia selection, generate-and-verify wiring, recognition verification, selector safety,
max-strength and base-selection regression tests passed. Typecheck, changed-file Biome checks,
`git diff --check`, and the production build (including dist verification and release packaging)
passed. The build produced `release/sliced-2.0.0.zip` from the current checkout, including its
pre-existing timing edits. This is offline validation; no live Chrome game or playing-strength
calibration was performed. Changes were not committed or pushed.
