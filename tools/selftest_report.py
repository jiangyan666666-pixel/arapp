"""Summarise self-test data (iPhone uploads in notes/selftest/, or 8T JSON exports).

    python tools/selftest_report.py notes/selftest/iphone-*.json
    python tools/selftest_report.py notes/selftest            # every .json in the folder

Prints, per instruction (A / B / C) and per block: accuracy (all trials and without
scaled ones), answer "fits" by delta, confidence when right vs wrong, time, remarks.
Duplicate blocks/trials across files (re-sent data) are counted once.
Standard library only.
"""

import glob
import json
import os
import sys
from collections import OrderedDict, defaultdict

DELTAS = [-6, -3, 0, 3, 6]
INSTR = {"A": "A 站着看", "B": "B 手当尺子", "C": "C 走进空隙", "other": "其他"}


def load(paths):
    blocks, trials = OrderedDict(), OrderedDict()
    for p in paths:
        with open(p, encoding="utf-8-sig") as f:
            d = json.load(f)
        for b in d.get("blocks", []):
            blocks[b["id"]] = b
        for t in d.get("trials", []):
            trials[t["id"]] = t
    return blocks, list(trials.values())


def bucket(delta):
    return max(-6, min(6, round(delta / 3) * 3))


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else float("nan")


def pct(a, n):
    return f"{a}/{n} ({a / n:.0%})" if n else "—"


def report(title, ts):
    n = len(ts)
    kept = [t for t in ts if not t.get("scaled")]
    right = sum(1 for t in ts if t["correct"])
    right_kept = sum(1 for t in kept if t["correct"])
    print(f"  {title}: n={n}  correct {pct(right, n)}"
          + (f"  | without scaled: {pct(right_kept, len(kept))} ({n - len(kept)} scaled)" if len(kept) != n else ""))
    row = []
    for d in DELTAS:
        sub = [t for t in kept if bucket(t["delta_cm"]) == d]
        fits = sum(1 for t in sub if t["answer"] == "fits")
        row.append(f"{d:+d}:{fits}/{len(sub)}" if sub else f"{d:+d}:—")
    print("    answered 'fits' by delta (truth fits for delta <= 0): " + "  ".join(row))
    two = [t for t in kept if t.get("firstAnswer")]
    if two:
        r1 = sum(1 for t in two if t["firstCorrect"])
        changed = [t for t in two if t["firstAnswer"] != t["answer"]]
        better = sum(1 for t in changed if t["correct"])
        row1 = []
        for d in DELTAS:
            sub = [t for t in two if bucket(t["delta_cm"]) == d]
            fits = sum(1 for t in sub if t["firstAnswer"] == "fits")
            row1.append(f"{d:+d}:{fits}/{len(sub)}" if sub else f"{d:+d}:—")
        print(f"    (1) first glance: correct {pct(r1, len(two))}   changed answer {len(changed)} (to right {better}, to wrong {len(changed) - better})")
        print("    (1) first glance 'fits' by delta:                    " + "  ".join(row1))
        strat = defaultdict(int)
        for t in two:
            for k in t.get("strategies") or []:
                strat[k] += 1
        if strat:
            print("    (2) how looked: " + ", ".join(f"{k} {v}" for k, v in sorted(strat.items(), key=lambda kv: -kv[1])))
    print(f"    confidence right {mean([t['confidence'] for t in kept if t['correct']]):.1f} / "
          f"wrong {mean([t['confidence'] for t in kept if not t['correct']]):.1f}   "
          f"time to answer {mean([t.get('timeToAnswer_s') for t in kept]):.1f} s   "
          f"AR opens per trial {mean([t.get('openCount') for t in kept]):.1f}")


def main():
    args = sys.argv[1:] or ["notes/selftest"]
    paths = []
    for a in args:
        paths += sorted(glob.glob(os.path.join(a, "*.json"))) if os.path.isdir(a) else glob.glob(a)
    blocks, trials = load(paths)
    print(f"{len(paths)} file(s), {len(blocks)} block(s), {len(trials)} trial(s)\n")

    by_block = defaultdict(list)
    for t in trials:
        by_block[t["blockId"]].append(t)
    for bid, b in blocks.items():
        ts = sorted(by_block.get(bid, []), key=lambda t: t["index"])
        print(f"block {b.get('createdAt', '')[:16].replace('T', ' ')}  {b.get('platform', 'android-webxr')}  "
              f"{INSTR.get(b.get('instruction'), b.get('instruction'))}  W {b.get('W_cm')} cm  {b.get('modelId')}  "
              f"{len(ts)}/{b.get('nTrials')} {'done' if b.get('completed') else 'aborted'}"
              + (f"  note: {b['note']}" if b.get("note") else ""))
        report("this block", ts)
        for t in ts:
            if t.get("remark"):
                print(f"    #{t['index'] + 1} (delta {t['delta_cm']:+g}, {t['answer']}, {'right' if t['correct'] else 'WRONG'}"
                      f"{', scaled' if t.get('scaled') else ''}) {t['remark']}")
        print()

    by_instr = defaultdict(list)
    for t in trials:
        b = blocks.get(t["blockId"], {})
        by_instr[b.get("instruction", "?")].append(t)
    if len(by_instr) > 1 or len(blocks) > 1:
        print("by instruction (all blocks pooled):")
        for k in ["A", "B", "C", "other", "?"]:
            if by_instr.get(k):
                report(INSTR.get(k, k), by_instr[k])


if __name__ == "__main__":
    main()
