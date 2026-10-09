"""Checks for models/bandit.py. Run: python3 models/test_bandit.py (no network, standard library only)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bandit as b  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = open(os.path.join(HERE, "bandit_sample.md")).read()
HEAD = "| ID | Type | Status |\n|---|---|---|\n"


def table(rows):
    return HEAD + "".join(f"| X{i} | {t} | {s} |\n" for i, (t, s) in enumerate(rows))


def test_parse_and_tally():
    rows = b.parse_rows(SAMPLE)
    assert len(rows) == 6
    counts, warnings = b.tally(rows)
    assert counts["outreach"] == {"kept": 2, "closed": 0, "open": 0}
    assert counts["self-edit"]["open"] == 1
    assert warnings == []


def test_unknown_rows_are_reported_not_counted():
    counts, warnings = b.tally(b.parse_rows(table([("tweet", "kept"), ("post", "maybe"), ("Post", "Kept")])))
    assert counts["post"]["kept"] == 1
    assert len(warnings) == 2


def test_probabilities_sum_to_one_and_repeat():
    r1 = b.model(SAMPLE, draws=4000, seed=3)
    r2 = b.model(SAMPLE, draws=4000, seed=3)
    assert r1 == r2
    assert abs(sum(a["p_best"] for a in r1["arms"].values()) - 1) < 1e-9
    for a in r1["arms"].values():
        assert 0 <= a["low"] <= a["mean"] <= a["high"] <= 1


def test_a_clearly_better_arm_wins():
    good, bad = [("kept",)] * 9 + [("closed",)], [("kept",)] + [("closed",)] * 9
    rows = [("outreach", s) for (s,) in good]
    rows += [(t, s) for t in ("post", "culture", "product", "self-edit") for (s,) in bad]
    r = b.model(table(rows), draws=6000)
    assert next(iter(r["arms"])) == "outreach"
    assert r["arms"]["outreach"]["p_best"] > 0.95
    assert r["enough_data"]


def test_untried_arms_keep_a_chance():
    """Thompson sampling explores: a Type never tried can still be picked, a Type that keeps failing rarely is."""
    rows = [("outreach", "kept")] * 9 + [("outreach", "closed")] + [("post", "kept")] + [("post", "closed")] * 9
    r = b.model(table(rows), draws=6000)
    assert next(iter(r["arms"])) == "outreach"
    assert r["arms"]["post"]["p_best"] < 0.01
    for t in ("culture", "product", "self-edit"):
        assert 0.05 < r["arms"][t]["p_best"] < 0.3


def test_flat_start_says_so():
    r = b.model(table([]), draws=5000)
    assert r["scored"] == 0 and not r["enough_data"]
    for a in r["arms"].values():  # five flat arms: each about one in five
        assert 0.15 < a["p_best"] < 0.25
    assert "needs 20" in b.render(r, "2026-10-09")


def test_write_replaces_only_its_section():
    r = b.model(SAMPLE, draws=2000)
    once = b.write_section(SAMPLE, b.render(r, "2026-10-09"))
    twice = b.write_section(once, b.render(r, "2026-10-09"))
    assert once == twice
    assert once.count(b.HEADING) == 1
    assert "| S6 |" in once and "## Bets" in once
    assert "(written by models/bandit.py --write)" not in once
    added = b.write_section("# Title\n\n## Bets\n" + table([("post", "open")]), b.render(r, "2026-10-09"))
    assert added.index(b.HEADING) < added.index("## Bets")


def test_enough_data_names_the_column():
    rows = [("outreach", "kept")] * 10 + [("post", "closed")] * 10
    text = b.render(b.model(table(rows), draws=2000), "2026-10-12")
    assert 'in proportion to the "Chance it is the best next move" column' in text
    assert "\u2014" not in text and "\u2013" not in text and "!" not in text


def test_header_only_table_is_a_flat_start():
    assert b.parse_rows("no table here") is None
    empty = "## Bets\n" + HEAD
    assert b.parse_rows(empty) == []
    assert "needs 20" in b.render(b.model(empty, draws=2000), "2026-10-12")


def test_escaped_pipes_stay_in_their_cell_and_bad_rows_say_why():
    text = "| ID | Type | Idea | Status |\n|---|---|---|---|\n| E1 | post | a \\| b idea | kept |\n| E2 | post | x | y | closed |\n"
    counts, warnings = b.tally(b.parse_rows(text))
    assert counts["post"]["kept"] == 1
    assert warnings == ["E2: 5 cells, want 4 (a pipe inside a cell?)"]


def test_bad_arguments_fail_cleanly():
    for argv in (["models/bandit_sample.md", "--draws", "0"], ["no-such-file.md"]):
        try:
            b.main([os.path.join(HERE, "..", a) if a.endswith(".md") else a for a in argv])
        except SystemExit as e:
            assert e.code == 2
        else:
            raise AssertionError(argv)


def test_house_style():
    text = b.render(b.model(SAMPLE, draws=2000), "2026-10-09")
    assert "—" not in text and "–" not in text and "!" not in text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
