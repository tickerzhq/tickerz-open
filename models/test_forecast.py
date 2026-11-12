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


def test_shadow_is_append_only_and_leaves_latest_alone():
    """The shadow writer only appends to shadow-log.csv, keeps the first forecast for a period, records a model that
    fails instead of raising, and never touches latest.json or log.csv."""
    import datetime as dt
    import tempfile
    import polars as pl

    df = pl.DataFrame({"period": [dt.date(2026, 9, 1) + dt.timedelta(days=i) for i in range(20)],
                       "y": [100.0 + i for i in range(20)]})
    res = f.run_series("MINTS", "day", df)
    assert res["status"] == "ok"
    saved = dict(f.SHADOW_FNS)
    try:
        with tempfile.TemporaryDirectory() as d:
            latest = os.path.join(d, "latest.json")
            log = os.path.join(d, "log.csv")
            with open(latest, "w") as fh:
                fh.write('{"version": "forecast-v1"}\n')
            f.append_csv(log, f.LOG_HEADER, [["t", "MINTS", res["next"]["period"], "ensemble", "1", "2", "3", f.VERSION]])
            before = {p: open(p, "rb").read() for p in (latest, log)}

            def ok(level):
                return lambda contexts: [{0.1: level - 1.0, 0.5: level, 0.9: level + 1.0} for _ in contexts]

            def broken(contexts):
                raise SystemExit("weights did not download")

            f.SHADOW_FNS.clear()
            f.SHADOW_FNS.update({"chronos2": ok(120.0), "timesfm25": ok(130.0)})
            f.run_shadow(d, [res], {"MINTS": df}, {}, "2026-11-12T00:00:00Z", dry=False)
            first = open(os.path.join(d, "shadow-log.csv")).read()
            assert [r["model"] for r in f.read_csv(os.path.join(d, "shadow-log.csv"))] == ["chronos2", "timesfm25", "fm_average"]
            avg = f.read_csv(os.path.join(d, "shadow-log.csv"))[2]
            assert float(avg["p50"]) == 125.0

            # A second run for the same period with new numbers and one model failing: nothing is rewritten.
            f.SHADOW_FNS.update({"chronos2": ok(999.0), "timesfm25": broken})
            f.run_shadow(d, [res], {"MINTS": df}, {}, "2026-11-13T00:00:00Z", dry=False)
            assert open(os.path.join(d, "shadow-log.csv")).read() == first
            doc = __import__("json").load(open(os.path.join(d, "shadow.json")))
            assert doc["models"]["timesfm25"]["status"] == "failed"
            assert doc["models"]["fm_average"]["status"] == "skipped"
            assert {p: open(p, "rb").read() for p in (latest, log)} == before

            # A later period is appended after the earlier rows.
            df2 = pl.concat([df, pl.DataFrame({"period": [dt.date(2026, 9, 21)], "y": [120.0]})])
            res2 = f.run_series("MINTS", "day", df2)
            f.run_shadow(d, [res2], {"MINTS": df2}, {}, "2026-11-14T00:00:00Z", dry=False)
            assert open(os.path.join(d, "shadow-log.csv")).read().startswith(first)
            assert {p: open(p, "rb").read() for p in (latest, log)} == before
    finally:
        f.SHADOW_FNS.clear()
        f.SHADOW_FNS.update(saved)


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
