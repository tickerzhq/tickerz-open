#!/usr/bin/env python3
"""Mirror what Tickerz printed into this repo, so the record does not depend on Tickerz's own servers.

For each index below it downloads the public settlement file (one row per complete period: the first print, the value
a contract settles on, any later revision, and the Bitcoin proof day) and writes it to prints/<TICKER>.csv. It also
saves each daily proof to daily-proofs/<day>.json, and fills in the Bitcoin block once when it confirms. Git history then shows every change anyone ever made.

It refuses to write when the new file would break the record:
  - a first print that is already in this repo has a different value, or
  - a period that is already in this repo is missing, or
  - a daily proof's digest differs from the one saved here.
Either one fails the run, and the difference is printed. Run: python3 scripts/mirror.py
"""
import csv, io, json, os, sys, urllib.request

BASE = "https://tickerz.com"
# Indexes counted from sources whose terms allow republishing the count.
TICKERS = ["LAYOFFS", "MINTS", "GIGS", "WAGE"]
UA = {"User-Agent": "tickerz-agent/mirror"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEADER = ["ticker", "period", "value", "settlement_value", "revised", "revised_on", "band", "z", "proof_day", "bitcoin_height", "proof_url"]


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=UA), timeout=60) as r:
        if r.status != 200:
            raise SystemExit(f"{path}: HTTP {r.status}")
        return r.read().decode("utf-8")


def rows_of(text):
    r = list(csv.reader(io.StringIO(text)))
    if not r or r[0] != HEADER:
        raise SystemExit(f"unexpected header: {r[0] if r else None}")
    return r[1:]


def check(ticker, old_rows, new_rows):
    """The record only grows: no period disappears and no first print changes."""
    new = {row[1]: row for row in new_rows}
    problems = []
    for row in old_rows:
        period, first_print = row[1], row[2]
        if period not in new:
            problems.append(f"{ticker} {period}: in this repo, missing from the new file")
        elif new[period][2] != first_print:
            problems.append(f"{ticker} {period}: first print was {first_print}, the new file says {new[period][2]}")
    return problems


def main():
    problems, changed, proof_days = [], [], set()
    for folder in ("prints", "daily-proofs"):
        os.makedirs(os.path.join(ROOT, folder), exist_ok=True)
    for ticker in TICKERS:
        text = get(f"/api/indices/{ticker.lower()}/history.csv")
        new_rows = rows_of(text)
        if not new_rows:
            raise SystemExit(f"{ticker}: the settlement file is empty")
        path = os.path.join(ROOT, "prints", f"{ticker}.csv")
        old_text = open(path).read() if os.path.exists(path) else ""
        old_rows = rows_of(old_text) if old_text else []
        problems += check(ticker, old_rows, new_rows)
        proof_days.update(row[8] for row in new_rows[-14:] if row[8])
        if text != old_text:
            changed.append((path, text, f"{ticker}: {len(old_rows)} to {len(new_rows)} periods"))
    if problems:
        print("The record changed. Nothing was written.\n" + "\n".join(problems))
        sys.exit(1)
    for path, text, note in changed:
        open(path, "w").write(text)
        print(note)
    for day in sorted(proof_days):
        path = os.path.join(ROOT, "daily-proofs", f"{day}.json")
        have = json.load(open(path)) if os.path.exists(path) else None
        if have and have.get("bitcoin_height"):
            continue  # complete: a proof with its Bitcoin block is never rewritten
        body = get(f"/api/indices/proof?day={day}")
        new = json.loads(body)
        if have and new.get("digest_sha256") != have.get("digest_sha256"):
            print(f"The record changed. proof {day}: digest was {have.get('digest_sha256')}, now {new.get('digest_sha256')}")
            sys.exit(1)
        if have and not new.get("bitcoin_height"):
            continue  # still waiting for its Bitcoin block
        open(path, "w").write(body if body.endswith("\n") else body + "\n")
        print(f"proof {day}" + ("" if new.get("bitcoin_height") else " (Bitcoin block pending)"))
    if not changed:
        print("no new prints")


if __name__ == "__main__":
    main()
