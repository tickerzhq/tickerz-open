"""Checks for models/forecast.py. Run: python3 models/test_forecast.py (no network)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forecast as f  # noqa: E402


def test_no_look_ahead():
    """A backtest forecast for period t must not change when any number after t changes."""
    rng = np.random.default_rng(7)
    y = 1000 + np.cumsum(rng.normal(0, 30, 70))
    models = f.candidates(len(y), "day")
    for name, fn in models.items():
        a = f.walk_forward(y, fn)
        z = y.copy()
        z[40:] *= 3  # change the future
        b = f.walk_forward(z, fn)
        for ra, rb in zip(a, b):
            if ra["t"] < 40:
                assert ra["q"] == rb["q"], (name, ra["t"])


def test_pinball_and_range():
    q = {0.1: 90.0, 0.5: 100.0, 0.9: 110.0}
    assert f.pinball(100.0, q) == (0.1 * 10 + 0 + 0.1 * 10) / 3
    space = f.Space([5.0, 6.0])
    r = f.quantiles(100.0, [-0.2, -0.1, 0.0, 0.1, 0.2, 0.05, -0.05, 0.15], [90.0, 100.0], space)
    assert r[0.1] <= r[0.5] <= r[0.9]


def test_negative_series_and_periods():
    y = np.array([33000, 134000, -10000, 162000, 29000, 50000, -23000, 80000, 90000, 10000, 120000, 70000, 40000.0])
    import polars as pl
    import datetime as dt
    df = pl.DataFrame({"period": [dt.date(2025, m, 1) for m in range(1, 13)] + [dt.date(2026, 1, 1)], "y": y})
    res = f.run_series("JOBS", "month", df)
    assert res["status"] == "ok"
    assert res["next"]["period"] == "2026-02-01"
    assert res["next"]["p10"] <= res["next"]["p50"] <= res["next"]["p90"]
    assert f.next_period(dt.date(2026, 12, 1), "month") == dt.date(2027, 1, 1)
    assert f.next_period(dt.date(2026, 9, 26), "week") == dt.date(2026, 10, 3)


def test_live_record_keeps_first_forecast():
    log = [
        {"ticker": "MINTS", "period": "2026-10-07", "p10": "40000", "p50": "50000", "p90": "60000"},
        {"ticker": "MINTS", "period": "2026-10-07", "p10": "1", "p50": "2", "p90": "3"},
    ]
    rec = f.live_record(log, {"MINTS": {"2026-10-07": 55000.0}})["MINTS"]
    assert rec["forecasts"] == 1 and rec["scored"] == 1 and rec["inside_80"] == 1


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
