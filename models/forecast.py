#!/usr/bin/env python3
"""Tickerz Forecast v1: where each index's next number is likely to land, and how well that has worked so far.

Display only. A forecast never touches a printed or settled number: those are counted by code in the tickerz
repo and recounted by this repo's src/. This file reads the public settlement files and writes forecasts/.

For every index it:
  1. Backtests each candidate model walk-forward, with no look-ahead: at each past period t the model sees only the
     numbers as first published before t and forecasts t. Scored by pinball loss at the 10th, 50th and 90th
     percentile and by how often the actual number fell inside the 10 to 90 range (coverage, 80% is right).
  2. Picks the model with the lowest pinball loss over the most recent RECENT periods (self-correcting: a model that
     stops working loses the series the next day). The choice is appended to forecasts/selection.csv.
  3. Forecasts the next period with that model and appends the forecast to forecasts/log.csv before the number is
     known. A row in log.csv is never rewritten; the live track record joins it with the prints as they land.

Ranges: every model gives a middle number; the 10th and 90th percentiles come from that model's own past errors
(empirical quantiles of its walk-forward residuals, on a log scale for series that are always positive). With fewer
than MIN_RESID past errors the range is a normal approximation from the spread of period-to-period changes.

Run: python3 models/forecast.py [--hist DIR] [--out forecasts] [--today YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import sys
import time
import urllib.request
import warnings

import numpy as np
import polars as pl

warnings.filterwarnings("ignore")

VERSION = "forecast-v1"
BASE = "https://tickerz.com"
UA = {"User-Agent": "tickerz-agent/models", "x-tickerz-agent": "models"}
QUANTS = (0.1, 0.5, 0.9)
RECENT = 14  # periods the selection looks back over
DEFAULT = "ensemble"  # the model a series uses unless another has clearly done better
MARGIN = 0.10  # another model must have a recent loss this much lower than the default's to take over
MIN_TRAIN = 8  # periods a model needs before it forecasts
MIN_RESID = 8  # past errors needed for an empirical range
LGBM_MIN = 60  # periods before gradient-boosted trees are a candidate
Z90 = 1.2815515655446004  # standard normal 90th percentile


# ---------- data ----------

def fetch(path: str, tries: int = 4) -> str:
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=UA), timeout=60) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # network errors are retried, then raised
            last = e
            time.sleep(2 ** i)
    raise SystemExit(f"{path}: {last}")


def registry() -> list[dict]:
    d = json.loads(fetch("/api/indices"))
    return [{"ticker": i["ticker"], "period": i.get("period", "day"), "unit": i.get("unit")} for i in d["indices"]]


def load_series(ticker: str, hist_dir: str | None, today: dt.date) -> pl.DataFrame:
    """One row per complete period: the number as first published where Tickerz kept it, else the value."""
    if hist_dir:
        with open(os.path.join(hist_dir, f"{ticker.lower()}.csv"), encoding="utf-8") as f:
            text = f.read()
    else:
        text = fetch(f"/api/indices/{ticker.lower()}/history.csv")
    df = pl.read_csv(io.StringIO(text), infer_schema_length=0)
    settle = pl.col("settlement_value").cast(pl.Float64, strict=False) if "settlement_value" in df.columns else pl.lit(None)
    df = (
        df.with_columns(
            pl.col("period").str.to_date().alias("period"),
            pl.coalesce(settle, pl.col("value").cast(pl.Float64, strict=False)).alias("y"),
        )
        .filter(pl.col("y").is_not_null() & (pl.col("period") < today))
        .select("period", "y")
        .unique("period", keep="first")
        .sort("period")
    )
    return df


def next_period(last: dt.date, period: str) -> dt.date:
    if period == "month":
        return dt.date(last.year + (last.month == 12), last.month % 12 + 1, 1)
    return last + dt.timedelta(days=7 if period == "week" else 1)


# ---------- models: each maps a history (np.ndarray) to a middle forecast for the next period ----------

def m_naive(y):
    return float(y[-1])


def m_mean7(y):
    return float(np.mean(y[-7:]))


def m_median7(y):
    return float(np.median(y[-7:]))


def m_snaive7(y):
    return float(y[-7]) if len(y) >= 14 else float(y[-1])


def m_drift(y):
    w = y[-8:]
    return float(w[-1] + (w[-1] - w[0]) / max(len(w) - 1, 1))


def _sf(model_cls, **kw):
    def f(y):
        from statsforecast.models import AutoETS, AutoTheta  # noqa: F401  (imported lazily: numba warms once)
        m = model_cls(**kw)
        m.fit(np.asarray(y, dtype=float))
        return float(m.predict(h=1)["mean"][0])
    return f


class NotReady(Exception):
    """A model that needs more history than a backtest step has. Only lgbm raises it, during its warm-up."""


LGBM_WARMUP = 10  # training rows lgbm needs; before that a backtest step uses drift8 and counts it as warm-up


def _lgbm(y):
    """Gradient-boosted trees on lags 1, 2, 7 and the 7-period mean, predicting the change from the last value."""
    import lightgbm as lgb
    y = np.asarray(y, dtype=float)
    L = 7
    if len(y) - L < LGBM_WARMUP:
        raise NotReady
    X, T = [], []
    for t in range(L, len(y)):
        X.append([y[t - 1], y[t - 2], y[t - 7], np.mean(y[t - 7:t])])
        T.append(y[t] - y[t - 1])
    reg = lgb.LGBMRegressor(n_estimators=120, learning_rate=0.05, num_leaves=7, min_child_samples=5, verbose=-1)
    reg.fit(np.array(X), np.array(T))
    x = [[y[-1], y[-2], y[-7], np.mean(y[-7:])]]
    return float(y[-1] + reg.predict(np.array(x))[0])


def candidates(n: int, period: str) -> dict:
    from statsforecast.models import AutoETS, AutoTheta
    c = {"naive": m_naive, "mean7": m_mean7, "median7": m_median7, "drift8": m_drift,
         "ets": _sf(AutoETS, season_length=1), "theta": _sf(AutoTheta, season_length=1)}
    if period == "day":
        c["seasonal_naive7"] = m_snaive7
    if n >= LGBM_MIN:
        c["lgbm"] = _lgbm
    parts = dict(c)
    # The middle of every candidate's forecast: rarely the best, rarely the worst. A candidate that fails is left out
    # of the middle, never replaced by the last number (until Oct 10 2026 a missing scikit-learn made lgbm fail, and
    # the whole ensemble fell back to the last number without saying so).
    def ensemble(y):
        mids = []
        for f in parts.values():
            try:
                v = f(y)
            except Exception:
                continue
            if math.isfinite(v):
                mids.append(v)
        if len(mids) < 3:
            raise RuntimeError("fewer than three candidates ran")
        return float(np.median(mids))
    c["ensemble"] = ensemble
    return c


# ---------- scoring ----------

def pinball(y: float, q: dict) -> float:
    return float(np.mean([max(a * (y - q[a]), (a - 1) * (y - q[a])) for a in QUANTS]))


class Space:
    """Log scale for series that are always positive, so ranges scale with the level; plain scale otherwise."""

    def __init__(self, y):
        self.log = bool(np.all(np.asarray(y) > 0))

    def fwd(self, v):
        return np.log(v) if self.log else np.asarray(v, dtype=float)

    def back(self, v):
        return float(np.exp(v)) if self.log else float(v)


def quantiles(mid: float, resid: list[float], hist, space: Space) -> dict:
    m = float(space.fwd(max(mid, 1e-12)) if space.log else mid)
    if len(resid) >= MIN_RESID:
        lo, hi = np.quantile(resid, 0.1), np.quantile(resid, 0.9)
    else:
        d = np.diff(space.fwd(hist))
        s = float(np.std(d, ddof=1)) if len(d) > 2 else abs(m) * 0.1 or 1.0
        lo, hi = -Z90 * s, Z90 * s
    lo, hi = min(lo, 0.0), max(hi, 0.0)
    return {0.1: space.back(m + lo), 0.5: space.back(m), 0.9: space.back(m + hi)}


class ModelFailed(Exception):
    pass


def walk_forward(y: np.ndarray, fn) -> list[dict]:
    """Forecast every period from MIN_TRAIN on, each from the periods before it only. A model that fails or returns
    nothing usable at any step is out for this series (ModelFailed): it is never scored as the last number."""
    space = Space(y)
    out, resid = [], []
    for t in range(MIN_TRAIN, len(y)):
        hist = y[:t]
        try:
            mid = fn(hist)
        except NotReady:
            mid = m_drift(hist)  # declared warm-up, not a failure: see LGBM_WARMUP
        except Exception as e:
            raise ModelFailed(f"{type(e).__name__}: {e}"[:200]) from e
        if not math.isfinite(mid):
            raise ModelFailed("not a finite number")
        q = quantiles(mid, resid, hist, space)
        out.append({"t": t, "y": float(y[t]), "q": q})
        resid.append(float(space.fwd(y[t]) - space.fwd(max(mid, 1e-12) if space.log else mid)))
    return out


def summarize(rows: list[dict], scale: float) -> dict:
    if not rows:
        return {"n": 0}
    pb = [pinball(r["y"], r["q"]) for r in rows]
    cov = [r["q"][0.1] <= r["y"] <= r["q"][0.9] for r in rows]
    ae = [abs(r["y"] - r["q"][0.5]) for r in rows]
    rec = rows[-RECENT:]
    return {
        "n": len(rows),
        "pinball": round(float(np.mean(pb)), 6),
        "pinball_scaled": round(float(np.mean(pb)) / scale, 4) if scale else None,
        "recent_pinball_scaled": round(float(np.mean([pinball(r["y"], r["q"]) for r in rec])) / scale, 4) if scale else None,
        "coverage_80": round(float(np.mean(cov)), 3),
        "mae": round(float(np.mean(ae)), 6),
        "mape": round(float(np.mean([a / abs(r["y"]) for a, r in zip(ae, rows) if r["y"]])) * 100, 2)
        if any(r["y"] for r in rows) else None,
    }


# ---------- one series ----------

def run_series(ticker: str, period: str, df: pl.DataFrame) -> dict | None:
    y = df["y"].to_numpy().astype(float)
    periods = df["period"].to_list()
    if len(y) < MIN_TRAIN + 4:
        return {"ticker": ticker, "period": period, "status": "too_short", "n": int(len(y))}
    # Scale for comparing series: the mean absolute period-to-period change over the backtest window.
    scale = float(np.mean(np.abs(np.diff(y[MIN_TRAIN - 1:])))) or 1.0
    models = candidates(len(y), period)
    bt, failed = {}, {}
    for name, fn in list(models.items()):
        try:
            rows = walk_forward(y, fn)
        except ModelFailed as e:
            failed[name] = str(e)
            print(f"{ticker:8s} model {name} failed and is left out: {e}", file=sys.stderr)
            del models[name]
            continue
        bt[name] = {"rows": rows, "score": summarize(rows, scale)}
    if DEFAULT not in models:
        return {"ticker": ticker, "period": period, "status": "model_failed", "failed_models": failed, "n": int(len(y))}
    def choose(score_of) -> str:
        """The default model, unless another's recent loss is at least MARGIN lower (switching costs: see the backtest)."""
        best = min(models, key=score_of)
        return best if score_of(best) < (1 - MARGIN) * score_of(DEFAULT) else DEFAULT

    chosen = choose(lambda k: bt[k]["score"]["recent_pinball_scaled"])
    # The honest backtest is of the whole procedure: at each past period, pick the model the way today's run does,
    # from the scores it had before that period only, and use its forecast. Choosing on the same numbers it is
    # scored on would flatter it.
    proc, base = [], []
    for i in range(len(bt["naive"]["rows"])):
        if i < 3:
            continue
        def prior(k):
            past = bt[k]["rows"][max(0, i - RECENT):i]
            return float(np.mean([pinball(r["y"], r["q"]) for r in past]))
        pick = choose(prior)
        proc.append(bt[pick]["rows"][i])
        base.append(bt["naive"]["rows"][i])
    proc_score, base_score = summarize(proc, scale), summarize(base, scale)
    # Forecast the next period with the chosen model, its range from its own past errors.
    space = Space(y)
    resid = [float(space.fwd(r["y"]) - space.fwd(max(r["q"][0.5], 1e-12) if space.log else r["q"][0.5])) for r in bt[chosen]["rows"]]
    try:
        mid = models[chosen](y)
    except Exception:
        mid = float(y[-1])
    q = quantiles(mid, resid, y, space)
    last = periods[-1]
    nxt = next_period(last, period)
    best = bt[chosen]["score"]
    return {
        "ticker": ticker,
        "period": period,
        "status": "ok",
        "last": {"period": last.isoformat(), "value": float(y[-1])},
        "next": {"period": nxt.isoformat(), "p10": q[0.1], "p50": q[0.5], "p90": q[0.9]},
        "model": chosen,
        "failed_models": failed,
        "n_history": int(len(y)),
        "backtest": {k: v["score"] for k, v in bt.items()},
        # The procedure, walked forward with no look-ahead, against repeating the last number on the same periods.
        "procedure": proc_score,
        "naive_same_periods": base_score,
        # Skill: how much smaller the procedure's loss is than repeating the last number (0 = no better, below 0 = worse).
        "skill_vs_naive": round(1 - proc_score["pinball"] / base_score["pinball"], 3)
        if proc_score.get("n") and base_score["pinball"] else None,
        "recent_window": min(RECENT, best["n"]),
        "_last_steps": [
            {"period": periods[r["t"]].isoformat(), "y": r["y"], "p10": r["q"][0.1], "p50": r["q"][0.5], "p90": r["q"][0.9]}
            for r in bt[chosen]["rows"][-RECENT:]
        ],
    }


# ---------- the live record ----------

LOG_HEADER = ["made_at", "ticker", "period", "model", "p10", "p50", "p90", "version"]
SEL_HEADER = ["day", "ticker", "model", "recent_pinball_scaled", "runner_up", "runner_up_score", "version"]


def append_csv(path: str, header: list[str], rows: list[list]) -> None:
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        if new:
            w.writerow(header)
        w.writerows(rows)


def read_csv(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def live_record(log_rows: list[dict], actual: dict) -> dict:
    """Each ticker's forecasts made before the number was known, scored once the number lands."""
    out = {}
    for t in sorted({r["ticker"] for r in log_rows}):
        rows = [r for r in log_rows if r["ticker"] == t]
        # The first forecast made for a period is the one that counts (later runs cannot improve it).
        first = {}
        for r in rows:
            first.setdefault(r["period"], r)
        scored = []
        for p, r in sorted(first.items()):
            a = actual.get(t, {}).get(p)
            if a is None:
                continue
            q = {0.1: float(r["p10"]), 0.5: float(r["p50"]), 0.9: float(r["p90"])}
            scored.append({"period": p, "y": a, "p10": q[0.1], "p50": q[0.5], "p90": q[0.9], "inside": q[0.1] <= a <= q[0.9]})
        out[t] = {
            "forecasts": len(first),
            "scored": len(scored),
            "inside_80": sum(s["inside"] for s in scored),
            "recent": scored[-10:],
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hist", help="read <ticker>.csv from this folder instead of tickerz.com")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "forecasts"))
    ap.add_argument("--today", help="UTC day to run as (default: now)")
    ap.add_argument("--dry", action="store_true", help="write latest.json only, append nothing")
    a = ap.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    today = dt.date.fromisoformat(a.today) if a.today else now.date()
    os.makedirs(a.out, exist_ok=True)
    reg = registry() if not a.hist else [
        {"ticker": t.upper(), "period": p} for t, p in [
            ("layoffs", "week"), ("yesno", "day"), ("trenches", "day"), ("mints", "day"), ("gigs", "day"), ("wage", "day"),
            ("jobs", "month"), ("unemp", "month"), ("cpi", "month"), ("corecpi", "month")]
    ]
    series, actual, results = {}, {}, []
    for r in reg:
        df = load_series(r["ticker"], a.hist, today)
        series[r["ticker"]] = df
        actual[r["ticker"]] = {p.isoformat(): float(v) for p, v in zip(df["period"].to_list(), df["y"].to_list())}
        res = run_series(r["ticker"], r["period"], df)
        if r.get("unit"):
            res["unit"] = r["unit"]
        results.append(res)
        print(f"{r['ticker']:8s} {res.get('status')} model={res.get('model')} skill={res.get('skill_vs_naive')}", file=sys.stderr)

    log_path = os.path.join(a.out, "log.csv")
    sel_path = os.path.join(a.out, "selection.csv")
    made_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    if not a.dry:
        logged = {(r["ticker"], r["period"]) for r in read_csv(log_path)}
        new_log, new_sel = [], []
        selected_today = {(r["day"], r["ticker"]) for r in read_csv(sel_path)}
        for res in results:
            if res.get("status") != "ok":
                continue
            key = (res["ticker"], res["next"]["period"])
            if key not in logged:  # only the first forecast for a period is kept
                n = res["next"]
                new_log.append([made_at, res["ticker"], n["period"], res["model"], f"{n['p10']:.6g}", f"{n['p50']:.6g}", f"{n['p90']:.6g}", VERSION])
            if (today.isoformat(), res["ticker"]) not in selected_today:
                others = sorted((kv for kv in res["backtest"].items() if kv[0] != res["model"]), key=lambda kv: kv[1]["recent_pinball_scaled"])
                ru = others[0] if others else (None, {"recent_pinball_scaled": None})
                mine = res["backtest"][res["model"]]["recent_pinball_scaled"]
                new_sel.append([today.isoformat(), res["ticker"], res["model"], mine, ru[0], ru[1]["recent_pinball_scaled"], VERSION])
        append_csv(log_path, LOG_HEADER, new_log)
        append_csv(sel_path, SEL_HEADER, new_sel)

    doc = {
        "version": VERSION,
        "generated_at": made_at,
        "display_only": True,
        "note": "Forecasts of the next published number. Display only: never a settled number. Ranges are the 10th to 90th percentile.",
        "method": {"quantiles": list(QUANTS), "recent_window": RECENT, "min_train": MIN_TRAIN, "selection": "lowest pinball loss over the recent window, scaled by the mean period-to-period change"},
        "indices": results,
        "live": live_record(read_csv(log_path), actual),
    }
    with open(os.path.join(a.out, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, default=float)
        f.write("\n")


if __name__ == "__main__":
    main()
