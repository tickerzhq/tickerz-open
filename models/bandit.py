#!/usr/bin/env python3
"""Tickerz decision model: a Thompson-sampling bandit over the company's experiments.

Every experiment the company runs has a Type, the kind of move it is: a post, outreach, a culture move, a product
change, or a self-edit (the company changing its own agents' instructions). Those are the arms. When an experiment
is scored, it is kept (the scoreboard number it named moved: reward 1) or closed (it did not: reward 0).

For each Type the model keeps a belief about how often that kind of move works: Beta(1 + kept, 1 + closed), which
starts flat (any rate from 0% to 100% equally likely) and narrows as results come in. It draws a rate from every
belief many times and counts how often each Type comes out on top. That share is the chance the Type is the best
next move. Thompson sampling means picking moves in proportion to that chance: a Type with few tries still gets
some, and a Type that keeps working gets most. Open experiments are shown but not counted.

Honest about data: with fewer than MIN_SCORED scored experiments the ranking mostly reflects the flat start, and
the output says so; until then the weekly scoring of each experiment decides.

Input: a Markdown file whose experiments table has at least the columns Type and Status (the real table is private;
models/bandit_sample.md is a made-up example with the same shape). Output: a ranking on stdout, as JSON with --json, or
written into the file's "## Next moves (bandit)" section with --write. Standard library only.

Run: python3 models/bandit.py <experiments.md> [--json] [--write] [--draws 20000] [--seed 7] [--today YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import datetime as dt
from zoneinfo import ZoneInfo
import json
import random
import re
import sys
from pathlib import Path

TYPES = ("post", "outreach", "culture", "product", "self-edit")
REWARD = {"kept": 1, "closed": 0}
MIN_SCORED = 20
DRAWS = 20000
SEED = 7
HEADING = "## Next moves (bandit)"


def cells(line: str) -> list[str]:
    """The cells of one table row. A pipe with a backslash before it stays inside its cell."""
    parts = re.split(r"(?<!\\)\|", line.strip())
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return [p.strip().replace("\\|", "|") for p in parts]


def parse_rows(text: str) -> list[dict] | None:
    """Rows of the first Markdown table whose header has both Type and Status, or None when there is no such
    table. A row with the wrong number of cells is kept with _bad set, so tally() can say why it is not counted."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        head = cells(line)
        if "Type" not in head or "Status" not in head:
            continue
        rows = []
        for body in lines[i + 2 :]:
            if not body.lstrip().startswith("|"):
                break
            row = cells(body)
            if len(row) != len(head):
                rows.append({"ID": row[0] if row else "?",
                             "_bad": f"{len(row)} cells, want {len(head)} (a pipe inside a cell?)"})
            else:
                rows.append(dict(zip(head, row)))
        return rows
    return None


def tally(rows: list[dict]) -> tuple[dict, list[str]]:
    """Kept, closed and open counts per Type, plus warnings for rows the model cannot use."""
    counts = {t: {"kept": 0, "closed": 0, "open": 0} for t in TYPES}
    warnings = []
    for r in rows:
        if "_bad" in r:
            warnings.append(f"{r['ID']}: {r['_bad']}")
            continue
        kind = r.get("Type", "").strip().lower()
        status = r.get("Status", "").strip().lower()
        rid = r.get("ID", "?")
        if kind not in counts:
            warnings.append(f"{rid}: Type '{kind}' is not one of {', '.join(TYPES)}")
            continue
        if status not in ("kept", "closed", "open"):
            warnings.append(f"{rid}: Status '{status}' is not open, kept or closed")
            continue
        counts[kind][status] += 1
    return counts, warnings


def thompson(counts: dict, draws: int = DRAWS, seed: int = SEED) -> dict:
    """For each Type: chance it is the best next move, its expected success rate and a 90% range."""
    rng = random.Random(seed)
    types = list(counts)
    wins = dict.fromkeys(types, 0)
    samples = {t: [] for t in types}
    for _ in range(draws):
        best, best_v = None, -1.0
        for t in types:
            v = rng.betavariate(1 + counts[t]["kept"], 1 + counts[t]["closed"])
            samples[t].append(v)
            if v > best_v:
                best, best_v = t, v
        wins[best] += 1
    out = {}
    for t in types:
        s = sorted(samples[t])
        k, c = counts[t]["kept"], counts[t]["closed"]
        out[t] = {
            "p_best": wins[t] / draws,
            "mean": (1 + k) / (2 + k + c),
            "low": s[int(0.05 * (draws - 1))],
            "high": s[int(0.95 * (draws - 1))],
            **counts[t],
        }
    return dict(sorted(out.items(), key=lambda kv: -kv[1]["p_best"]))


def model(text: str, draws: int = DRAWS, seed: int = SEED) -> dict:
    counts, warnings = tally(parse_rows(text) or [])
    scored = sum(c["kept"] + c["closed"] for c in counts.values())
    return {
        "scored": scored,
        "enough_data": scored >= MIN_SCORED,
        "min_scored": MIN_SCORED,
        "draws": draws,
        "seed": seed,
        "arms": thompson(counts, draws, seed),
        "warnings": warnings,
    }


def pct(x: float) -> str:
    return f"{round(100 * x)}%"


def render(result: dict, today: str) -> str:
    """The Markdown section --write puts in the experiments file. Plain words, no dashes."""
    lines = [HEADING, ""]
    lead = (
        f"Updated {today} by tickerz-open models/bandit.py (Thompson sampling, {result['draws']:,} draws). "
        f"Scored experiments so far: {result['scored']}."
    )
    if result["enough_data"]:
        lead += ' Pick next moves in proportion to the "Chance it is the best next move" column.'
    else:
        lead += (
            f" The model needs {result['min_scored']} before its ranking means much; until then it mostly shows the"
            " flat starting assumption, and the weekly scoring of each experiment decides."
        )
    lines += [lead, "", "| Type | Chance it is the best next move | How often it works (90% range) | Kept | Closed | Open |",
              "|---|---|---|---|---|---|"]
    for t, a in result["arms"].items():
        lines.append(
            f"| {t} | {pct(a['p_best'])} | {pct(a['mean'])} ({pct(a['low'])} to {pct(a['high'])}) "
            f"| {a['kept']} | {a['closed']} | {a['open']} |"
        )
    for w in result["warnings"]:
        lines.append(f"\nNot counted: {w}")
    return "\n".join(lines) + "\n"


def write_section(text: str, section: str) -> str:
    """Replace the Next moves section (up to the next '## ' heading), or add it before the first table section."""
    lines = text.splitlines(keepends=True)
    start = next((i for i, l in enumerate(lines) if l.strip() == HEADING), None)
    if start is not None:
        end = next((j for j in range(start + 1, len(lines)) if lines[j].startswith("## ")), len(lines))
        return "".join(lines[:start]) + section + "\n" + "".join(lines[end:])
    first = next((i for i, l in enumerate(lines) if l.startswith("## ")), None)
    if first is None:
        return text.rstrip("\n") + "\n\n" + section
    return "".join(lines[:first]) + section + "\n" + "".join(lines[first:])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Thompson-sampling bandit over the experiments table.")
    ap.add_argument("experiments", type=Path)
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    ap.add_argument("--write", action="store_true", help="write the Next moves section into the file")
    ap.add_argument("--draws", type=int, default=DRAWS)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--today", default=dt.datetime.now(ZoneInfo("America/New_York")).date().isoformat(),
                    help="the date stamped on the section (default: today in New York)")
    args = ap.parse_args(argv)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.today):
        ap.error("--today must be YYYY-MM-DD")
    if args.draws < 1000:
        ap.error("--draws must be at least 1000")
    if not args.experiments.is_file():
        ap.error(f"no such file: {args.experiments}")
    text = args.experiments.read_text()
    if parse_rows(text) is None:
        print(f"no experiments table with Type and Status columns in {args.experiments}", file=sys.stderr)
        return 1
    result = model(text, args.draws, args.seed)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(render(result, args.today), end="")
    if args.write:
        args.experiments.write_text(write_section(text, render(result, args.today)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
