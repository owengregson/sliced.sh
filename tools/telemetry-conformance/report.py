#!/usr/bin/env python3
"""Offline telemetry-conformance report (Task 33 Step 4, Part I §13.2/§13.6, §8.4a/§8.4b).

Reads one or more Engine-view exports -- the panel's Engine view writes
`JSON.stringify(timingEntries)`, an array of `TimingLogEntry` (`src/types/timing.ts`) -- from
N real bot games and prints the per-move `ac`-equivalent summary: blur/toggle/trust counts,
the `DidSelectMultiplePieces` rate against the population band, the hold-time distribution
(CV, floor, quantiles, complexity correlation, time-pressure compression), the orientation
latency after every opponent move, and top-1 %/ACPL against the §7.2 agreement band.

`TimingLogEntry.telemetry` (`MoveTelemetryRecord`) is the optional field the `GameSession`
fills from Task 30 on. Exports written before that carry only the timing columns, so the
`ac` and move-quality sections print "not in export (pre-Task 30)" instead of guessing.

    usage: report.py [--target-elo N] [--json] [--bands] FILE [FILE ...]

Every threshold below mirrors the TypeScript registries; `bands.test.ts` fails the build if
the two drift apart. Nothing here imports from the extension: the report must run on a
checkout with no toolchain, against a JSON file the owner exported from the panel.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any

# --- BANDS: mirrors `TELEMETRY_BANDS` (src/core/constants/telemetry.ts) and `AGREEMENT_BANDS`
# (src/core/strength/constants.ts). `tools/telemetry-conformance/bands.test.ts` compares this
# literal against the registries and fails on any drift. Edit the registry, then this block. ---
BANDS = json.loads("""
{
  "blurCountMax": 0,
  "multiSelect": {
    "rate": [0.04, 0.12],
    "hardMax": 0.25,
    "minMovesForBand": 200,
    "minMovesForNonZero": 20,
    "minThinkMs": 1200,
    "minClockMs": 15000
  },
  "holdTime": {
    "cvMin": 0.5,
    "cvAfterMoves": 12,
    "minMs": 250,
    "complexityCorrMin": 0.2
  },
  "compression": {
    "pressureClockMs": 30000,
    "comfortableClockMs": 60000,
    "maxMeanRatio": 0.85,
    "minMovesPerSide": 10
  },
  "orientationMinMs": 150,
  "agreement": [
    { "elo": 800, "top1": [38, 45], "acpl": [100, 130] },
    { "elo": 1200, "top1": [42, 48], "acpl": [75, 95] },
    { "elo": 1600, "top1": [47, 53], "acpl": [45, 60] },
    { "elo": 2000, "top1": [52, 58], "acpl": [28, 40] },
    { "elo": 2400, "top1": [58, 66], "acpl": [15, 25] },
    { "elo": 2800, "top1": [68, 75], "acpl": [8, 15] }
  ]
}
""")

MISSING = "not in export (pre-Task 30)"
INSTANT_MODES = ("premove", "instant")


# ── loading ───────────────────────────────────────────────────────────────────


def load_entries(paths: list[str]) -> list[dict[str, Any]]:
    """Every `TimingLogEntry` of every export, in file order."""
    out: list[dict[str, Any]] = []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        rows = payload.get("entries", []) if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise SystemExit(f"{path}: expected a JSON array of TimingLogEntry")
        out.extend(row for row in rows if isinstance(row, dict))
    return out


def hold_ms(entry: dict[str, Any]) -> float | None:
    """The move's realised hold time: the `ac` blob's when exported, else `actualMs`."""
    ac = (entry.get("telemetry") or {}).get("ac")
    if isinstance(ac, dict) and isinstance(ac.get("MoveHoldTime"), (int, float)):
        return float(ac["MoveHoldTime"])
    actual = entry.get("actualMs")
    return float(actual) if isinstance(actual, (int, float)) else None


# ── statistics ────────────────────────────────────────────────────────────────


def stats(xs: list[float]) -> dict[str, float]:
    n = len(xs)
    if n == 0:
        return {"n": 0, "mean": 0.0, "sd": 0.0, "cv": 0.0, "min": 0.0, "max": 0.0, "q10": 0.0, "q50": 0.0, "q90": 0.0}
    ordered = sorted(xs)
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / n)

    def q(p: float) -> float:
        return ordered[min(n - 1, int(p * n))]

    return {
        "n": n,
        "mean": mean,
        "sd": sd,
        "cv": sd / mean if mean > 0 else 0.0,
        "min": ordered[0],
        "max": ordered[-1],
        "q10": q(0.1),
        "q50": q(0.5),
        "q90": q(0.9),
    }


def pearson(a: list[float], b: list[float]) -> float | None:
    n = min(len(a), len(b))
    if n < 2:
        return None
    ma = sum(a[:n]) / n
    mb = sum(b[:n]) / n
    sab = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    saa = sum((a[i] - ma) ** 2 for i in range(n))
    sbb = sum((b[i] - mb) ** 2 for i in range(n))
    if saa == 0 or sbb == 0:
        return None
    return sab / math.sqrt(saa * sbb)


def band_for(target_elo: int) -> dict[str, Any]:
    band = BANDS["agreement"][0]
    for candidate in BANDS["agreement"]:
        if target_elo >= candidate["elo"]:
            band = candidate
    return band


# ── summary ───────────────────────────────────────────────────────────────────


def summarize(entries: list[dict[str, Any]], target_elo: int) -> dict[str, Any]:
    games = sorted({str(e.get("gameId")) for e in entries if e.get("gameId") is not None})
    telemetry = [e for e in entries if isinstance(e.get("telemetry"), dict)]

    holds: list[float] = []
    normal_holds: list[float] = []
    pressure: list[float] = []
    comfortable: list[float] = []
    log_hold: list[float] = []
    log_alloc: list[float] = []
    under_floor: list[dict[str, Any]] = []
    complexity_axis = ["alloc"]
    for e in entries:
        h = hold_ms(e)
        if h is None:
            continue
        holds.append(h)
        instant = str(e.get("mode")) in INSTANT_MODES
        if not instant:
            normal_holds.append(h)
            if h < BANDS["holdTime"]["minMs"]:
                under_floor.append({"gameId": e.get("gameId"), "ply": e.get("ply"), "holdMs": h})
            clock = e.get("clockMs")
            if isinstance(clock, (int, float)):
                if clock < BANDS["compression"]["pressureClockMs"]:
                    pressure.append(h)
                elif clock >= BANDS["compression"]["comfortableClockMs"]:
                    comfortable.append(h)
            # §13.6 complexity axis: `telemetry.nReasonable` when the export has it (Task 30
            # on), else the model's per-move allocation `alloc` -- a clock-driven stand-in,
            # so the printed line says which axis was used.
            complexity = (e.get("telemetry") or {}).get("nReasonable")
            if not isinstance(complexity, (int, float)):
                complexity = e.get("alloc")
            else:
                complexity_axis[0] = "n_reasonable"
            if isinstance(complexity, (int, float)) and complexity > 0:
                log_hold.append(math.log(max(1.0, h)))
                log_alloc.append(math.log(complexity))

    p = stats(pressure)
    c = stats(comfortable)
    summary: dict[str, Any] = {
        "files": None,
        "games": games,
        "moves": len(entries),
        "movesWithHold": len(holds),
        "hold": stats(holds),
        "holdNormal": stats(normal_holds),
        "underFloor": under_floor,
        "holdVsComplexity": pearson(log_hold, log_alloc),
        "complexityAxis": complexity_axis[0],
        "compression": {"pressure": p, "comfortable": c, "ratio": (p["mean"] / c["mean"]) if p["n"] and c["n"] and c["mean"] else None},
        "targetElo": target_elo,
        "band": band_for(target_elo),
        "ac": None,
        "quality": None,
    }

    if not telemetry:
        return summary

    blur = sum(int(t["telemetry"]["ac"].get("BlurCount", 0)) for t in telemetry)
    toggles = sum(1 for t in telemetry if t["telemetry"]["ac"].get("DidToggle"))
    untrusted = sum(1 for t in telemetry if not t["telemetry"]["ac"].get("EventTrusted"))
    lichess_blur = sum(int(t["telemetry"].get("lichessBlur", 0)) for t in telemetry)
    focus_fields = sum(
        1
        for t in telemetry
        if any(
            t["telemetry"]["ac"].get(k)
            for k in ("DidBlurOnOwnTurn", "DidBlurOnOpponentTurn", "DidFocusOnOwnTurn", "DidFocusOnOpponentTurn")
        )
        or t["telemetry"]["ac"].get("LastFocusToMoveTime") is not None
        or t["telemetry"]["ac"].get("MoveToFirstBlurTime") is not None
    )
    eligible = [t for t in telemetry if t["telemetry"].get("multiSelectEligible")]
    multi = [t for t in eligible if t["telemetry"]["ac"].get("DidSelectMultiplePieces")]
    # §8.4b item 2: the orientation latency is the reaction to the opponent's move, so it applies
    # to every move the player actually waited for -- a premove is decided before that move lands.
    oriented = [t for t in telemetry if str(t.get("mode")) != "premove"]
    orientations = [
        float(t["telemetry"]["orientationMs"])
        for t in oriented
        if isinstance(t["telemetry"].get("orientationMs"), (int, float))
    ]
    summary["ac"] = {
        "n": len(telemetry),
        "oriented": len(oriented),
        "blur": blur,
        "toggles": toggles,
        "untrusted": untrusted,
        "lichessBlur": lichess_blur,
        "focusFieldsSet": focus_fields,
        "multiSelect": {
            "count": len(multi),
            "eligible": len(eligible),
            "rate": (len(multi) / len(eligible)) if eligible else None,
        },
        "orientation": stats(orientations),
        "orientationMissing": len(oriented) - len(orientations),
    }

    top1 = [t for t in telemetry if isinstance(t["telemetry"].get("top1"), bool)]
    losses = [float(t["telemetry"]["cpLoss"]) for t in telemetry if isinstance(t["telemetry"].get("cpLoss"), (int, float))]
    summary["quality"] = {
        "n": len(top1),
        "top1Pct": (100.0 * sum(1 for t in top1 if t["telemetry"]["top1"]) / len(top1)) if top1 else None,
        "acpl": (sum(losses) / len(losses)) if losses else None,
    }
    return summary


# ── printing ──────────────────────────────────────────────────────────────────


def ms(x: float) -> str:
    return f"{x:.0f} ms"


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100.0 * x:.1f} %"


def verdict(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def render(summary: dict[str, Any], paths: list[str]) -> tuple[str, bool]:
    hold = summary["holdNormal"]
    band = summary["band"]
    lines: list[str] = []
    failures: list[str] = []

    lines.append("telemetry conformance report (Part I §13)")
    lines.append(f"  sources        {len(paths)} export(s): {', '.join(paths)}")
    lines.append(f"  games          {len(summary['games'])} ({', '.join(summary['games']) or 'unnamed'})")
    lines.append(f"  moves          {summary['moves']} ({summary['movesWithHold']} with a realised hold time)")
    lines.append("")

    lines.append("hold time (§8.4a, §13.2 MoveHoldTime) — normal/long moves only")
    lines.append(
        f"  n={hold['n']} mean {ms(hold['mean'])} sd {ms(hold['sd'])} cv {hold['cv']:.2f}"
        f" · min {ms(hold['min'])} · q10/q50/q90 {ms(hold['q10'])} / {ms(hold['q50'])} / {ms(hold['q90'])}"
    )
    cv_checked = hold["n"] >= BANDS["holdTime"]["cvAfterMoves"]
    cv_ok = (not cv_checked) or hold["cv"] >= BANDS["holdTime"]["cvMin"]
    lines.append(
        f"  [{verdict(cv_ok)}] CV ≥ {BANDS['holdTime']['cvMin']}"
        + ("" if cv_checked else f" (not asserted below {BANDS['holdTime']['cvAfterMoves']} moves)")
    )
    floor_ok = not summary["underFloor"]
    lines.append(f"  [{verdict(floor_ok)}] no non-premove move under {ms(BANDS['holdTime']['minMs'])}")
    for row in summary["underFloor"][:10]:
        lines.append(f"        game {row['gameId']} ply {row['ply']}: {ms(row['holdMs'])}")
    corr = summary["holdVsComplexity"]
    # The §13.6 complexity check needs the position's `n_reasonable`. Only `telemetry` carries it,
    # so on a pre-Task-30 export the correlation is printed against the clock-driven `alloc`
    # column as information and is *not* asserted -- a low r there says nothing about complexity.
    corr_checked = summary["complexityAxis"] == "n_reasonable"
    corr_ok = (not corr_checked) or corr is None or corr >= BANDS["holdTime"]["complexityCorrMin"]
    lines.append(
        f"  [{verdict(corr_ok) if corr_checked else 'INFO'}] ln(hold) vs ln({summary['complexityAxis']}) r="
        + ("n/a" if corr is None else f"{corr:.2f}")
        + f" (min {BANDS['holdTime']['complexityCorrMin']})"
        + ("" if corr_checked else f" — n_reasonable {MISSING}, not asserted")
    )
    comp = summary["compression"]
    comp_checked = (
        comp["ratio"] is not None
        and comp["pressure"]["n"] >= BANDS["compression"]["minMovesPerSide"]
        and comp["comfortable"]["n"] >= BANDS["compression"]["minMovesPerSide"]
    )
    comp_ok = (not comp_checked) or comp["ratio"] <= BANDS["compression"]["maxMeanRatio"]
    lines.append(
        f"  [{verdict(comp_ok)}] time pressure mean {ms(comp['pressure']['mean'])} (n={comp['pressure']['n']})"
        f" vs comfortable {ms(comp['comfortable']['mean'])} (n={comp['comfortable']['n']}) · ratio "
        + ("n/a" if comp["ratio"] is None else f"{comp['ratio']:.2f}")
        + f" (max {BANDS['compression']['maxMeanRatio']})"
    )
    for name, ok in (("hold-time CV", cv_ok), ("hold-time floor", floor_ok), ("complexity correlation", corr_ok), ("time-pressure compression", comp_ok)):
        if not ok:
            failures.append(name)
    lines.append("")

    ac = summary["ac"]
    lines.append("ac blob (§13.2)")
    if ac is None:
        lines.append(f"  {MISSING} — TimingLogEntry.telemetry is filled by the GameSession from Task 30 on")
    else:
        blur_ok = ac["blur"] <= BANDS["blurCountMax"] and ac["toggles"] == 0 and ac["focusFieldsSet"] == 0
        lines.append(
            f"  [{verdict(blur_ok)}] blur {ac['blur']} (max {BANDS['blurCountMax']}) · toggles {ac['toggles']}"
            f" · focus fields set {ac['focusFieldsSet']} · lichess blur bits {ac['lichessBlur']}"
        )
        trust_ok = ac["untrusted"] == 0
        lines.append(f"  [{verdict(trust_ok)}] EventTrusted on all {ac['n']} moves ({ac['untrusted']} untrusted)")
        multi = ac["multiSelect"]
        band_checked = multi["eligible"] >= BANDS["multiSelect"]["minMovesForBand"]
        nonzero_checked = multi["eligible"] >= BANDS["multiSelect"]["minMovesForNonZero"]
        lo, hi = BANDS["multiSelect"]["rate"]
        multi_ok = True
        if multi["rate"] is not None and multi["rate"] > BANDS["multiSelect"]["hardMax"]:
            multi_ok = False
        if nonzero_checked and multi["count"] in (0, multi["eligible"]):
            multi_ok = False
        if band_checked and not (lo <= (multi["rate"] or 0) <= hi):
            multi_ok = False
        note = "" if band_checked else f" (band not asserted below {BANDS['multiSelect']['minMovesForBand']} non-trivial moves)"
        lines.append(
            f"  [{verdict(multi_ok)}] DidSelectMultiplePieces {pct(multi['rate'])}"
            f" ({multi['count']}/{multi['eligible']} non-trivial; band {pct(lo)}–{pct(hi)}, hard max {pct(BANDS['multiSelect']['hardMax'])}){note}"
        )
        orient = ac["orientation"]
        orient_ok = ac["orientationMissing"] == 0 and (orient["n"] == 0 or orient["min"] >= BANDS["orientationMinMs"])
        lines.append(
            f"  [{verdict(orient_ok)}] orientation latency present on all {ac['oriented']} non-premove moves"
            f" ({ac['orientationMissing']} missing) · min {ms(orient['min'])} median {ms(orient['q50'])}"
            f" (floor {ms(BANDS['orientationMinMs'])})"
        )
        for name, ok in (("zero blur/toggle", blur_ok), ("event trust", trust_ok), ("multi-select rate", multi_ok), ("orientation latency", orient_ok)):
            if not ok:
                failures.append(name)
    lines.append("")

    quality = summary["quality"]
    lines.append(f"move quality (§13.6, §7.2 band for target {summary['targetElo']} Elo)")
    if quality is None:
        lines.append(f"  {MISSING} — top1 / cpLoss ride on TimingLogEntry.telemetry (Task 30)")
    else:
        top1_ok = quality["top1Pct"] is None or band["top1"][0] <= quality["top1Pct"] <= band["top1"][1]
        acpl_ok = quality["acpl"] is None or band["acpl"][0] <= quality["acpl"] <= band["acpl"][1]
        lines.append(
            f"  [{verdict(top1_ok)}] top-1 "
            + ("n/a" if quality["top1Pct"] is None else f"{quality['top1Pct']:.1f} %")
            + f" (band {band['top1'][0]}–{band['top1'][1]} % at knot {band['elo']})"
        )
        lines.append(
            f"  [{verdict(acpl_ok)}] ACPL "
            + ("n/a" if quality["acpl"] is None else f"{quality['acpl']:.1f}")
            + f" (band {band['acpl'][0]}–{band['acpl'][1]})"
        )
        for name, ok in (("top-1 %", top1_ok), ("ACPL", acpl_ok)):
            if not ok:
                failures.append(name)
    lines.append("")

    lines.append("acceptance: " + ("PASS" if not failures else "FAIL — " + ", ".join(failures)))
    return "\n".join(lines), not failures


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Offline telemetry-conformance report (Task 33).")
    parser.add_argument("files", nargs="*", help="Engine-view JSON exports (arrays of TimingLogEntry)")
    parser.add_argument("--target-elo", type=int, default=1600, help="target Elo for the §7.2 band (default 1600)")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON instead of text")
    parser.add_argument("--bands", action="store_true", help="print the mirrored band constants as JSON and exit")
    args = parser.parse_args(argv)

    if args.bands:
        print(json.dumps(BANDS, indent=2, sort_keys=True))
        return 0
    if not args.files:
        parser.error("at least one export file is required")

    entries = load_entries(args.files)
    summary = summarize(entries, args.target_elo)
    summary["files"] = args.files
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True, default=str))
        return 0
    text, ok = render(summary, args.files)
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
