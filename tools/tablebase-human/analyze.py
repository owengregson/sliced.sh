"""Tables for docs/qa/endgame-tablebases-2026-09-23.md: python analyze.py <measure.py csv>..."""
import csv
import sys
from collections import defaultdict

BUCKETS = [(0, 1200), (1200, 1600), (1600, 2000), (2000, 2400), (2400, 2700), (2700, 4000)]


def bucket(e):
    for lo, hi in BUCKETS:
        if lo <= e < hi:
            return f"{lo}-{hi - 1}" if hi < 4000 else f"{lo}+"
    return None


def tcclass(src, tc):
    tc = int(tc)
    if src == "twic":
        return "otb"
    if tc < 0:
        return "?"
    if tc < 180:
        return "bullet"
    if tc < 480:
        return "blitz"
    return "rapid+"


rows = []
for f in sys.argv[1:]:
    with open(f) as fh:
        rows += list(csv.DictReader(fh))


def stats(sel):
    # decision positions: not every legal move equally optimal
    dec = [r for r in sel if int(r["nbest"]) < int(r["nlegal"])]
    risk = [r for r in sel if int(r["nkeep"]) < int(r["nlegal"])]  # some move throws the result
    n = len(dec)
    opt = sum(int(r["optimal"]) for r in dec)
    nr = len(risk)
    keep = sum(int(r["keeps"]) for r in risk)
    # baseline: random legal move optimal share
    rnd = sum(int(r["nbest"]) / int(r["nlegal"]) for r in dec)
    return n, opt / n if n else float("nan"), rnd / n if n else float("nan"), nr, keep / nr if nr else float("nan")


def table(title, key):
    groups = defaultdict(list)
    for r in rows:
        k = key(r)
        if k is not None:
            groups[k].append(r)
    print(f"\n## {title}")
    print("| group | n decisions | optimal | random-move optimal | n at-risk | result kept |")
    print("|---|---:|---:|---:|---:|---:|")
    for k in sorted(groups, key=str):
        n, o, rnd, nr, kp = stats(groups[k])
        if n < 30:
            continue
        print(f"| {k} | {n} | {o:.1%} | {rnd:.1%} | {nr} | {kp:.1%} |")


def mover_wdl(r):
    w = int(r["wdl"])
    return "won" if w == 2 else "lost" if w == -2 else "drawn/cursed"


table("by rating (all sources)", lambda r: bucket(int(r["elo"])))
table("by source x rating", lambda r: (r["src"], bucket(int(r["elo"]))))
table("by rating x men", lambda r: (bucket(int(r["elo"])), "3-4" if int(r["men"]) <= 4 else "5"))
table("by rating x theoretical result", lambda r: (bucket(int(r["elo"])), mover_wdl(r)))
table("by time class x rating", lambda r: (tcclass(r["src"], r["tc"]), bucket(int(r["elo"]))))

# game-level: first TB-won position per (src, game, colour) -> converted?; first drawn -> held?
first = {}
for r in rows:
    k = (r["src"], r["game"], r["color"])
    if k not in first:
        first[k] = r
conv = defaultdict(lambda: [0, 0])
hold = defaultdict(lambda: [0, 0])
for (src, game, color), r in first.items():
    res = r["result"]
    win = (res == "1-0" and color == "w") or (res == "0-1" and color == "b")
    loss = (res == "0-1" and color == "w") or (res == "1-0" and color == "b")
    b = bucket(int(r["elo"]))
    if int(r["wdl"]) == 2:
        conv[b][0] += 1
        conv[b][1] += int(win)
    if int(r["wdl"]) == 0:
        hold[b][0] += 1
        hold[b][1] += int(not loss)
print("\n## game level (first <=5-man position of each side)")
print("| rating | won positions | converted | drawn positions | held (not lost) |")
print("|---|---:|---:|---:|---:|")
for b in sorted(set(conv) | set(hold), key=str):
    c, h = conv[b], hold[b]
    print(f"| {b} | {c[0]} | {c[1] / c[0] if c[0] else float('nan'):.1%} | {h[0]} | {h[1] / h[0] if h[0] else float('nan'):.1%} |")
