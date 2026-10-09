"""
Applet: Tickerz
Summary: Tickerz index numbers
Description: The newest Tickerz number on a 64 by 32 LED display: the daily Close, or one index such as $LAYOFFS or $MINTS. Reads the free public API at tickerz.com, no key.
Author: Tickerz
"""

load("encoding/json.star", "json")
load("http.star", "http")
load("render.star", "render")
load("schema.star", "schema")

API = "https://tickerz.com/api/v1/indices/"

# The Close prints once a day and an index at most once a day; the API itself is cached for a minute.
TTL_SECONDS = 900

# Design system v4: plum is the one accent, bone the text, stone the second tone (graphite is too dim on LEDs).
PLUM = "#C77BCB"
BONE = "#EBEBEB"
STONE = "#A3A3A3"

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# The Close's rows carry only a ticker, so its format and period come from here. One index brings its own unit and step.
DOLLARS = ["YESNO", "TRENCHES", "WAGE"]
PERCENT = ["UNEMP", "CPI", "CORECPI"]
MONTHLY = ["JOBS", "UNEMP", "CPI", "CORECPI"]
WEEKLY = ["LAYOFFS"]

INDEXES = [
    ("The Tickerz Close", "close"),
    ("$LAYOFFS: US jobless claims, weekly", "layoffs"),
    ("$MINTS: memecoin launches on Solana", "mints"),
    ("$GIGS: paid AI agent calls on Base", "gigs"),
    ("$WAGE: median price of one of those calls", "wage"),
    ("$TRENCHES: memecoin launchpad fees", "trenches"),
    ("$YESNO: prediction market volume", "yesno"),
    ("$JOBS: US nonfarm payrolls, monthly", "jobs"),
    ("$UNEMP: US unemployment rate, monthly", "unemp"),
    ("$CPI: US consumer prices, month over month", "cpi"),
    ("$CORECPI: core consumer prices, month over month", "corecpi"),
]

def comma(n):
    """A whole number with thousands commas: 170732 -> "170,732"."""
    s = str(n)
    out = ""
    for i in range(len(s)):
        if i > 0 and (len(s) - i) % 3 == 0:
            out += ","
        out += s[i]
    return out

def fixed(a, digits):
    """A non-negative number to a fixed count of decimals, without float noise: fixed(3.547471, 2) -> "3.55"."""
    p = 1
    for _ in range(digits):
        p = p * 10
    n = int(a * p + 0.5)
    whole = str(n // p)
    if digits == 0:
        return whole
    return whole + "." + ("0000" + str(n % p))[-digits:]

def fmt_value(v, kind):
    """As the site writes a level: 170,732; $584.41M; $3.55M; $0.0100; 4.2%."""
    if v == None:
        return "--"
    sign = "-" if v < 0 else ""
    a = -v if v < 0 else v
    if kind == "percent":
        return sign + fixed(a, 1) + "%"
    if kind == "dollars":
        if a >= 1000000000:
            return sign + "$" + fixed(a / 1000000000, 2) + "B"
        if a >= 1000000:
            return sign + "$" + fixed(a / 1000000, 2) + "M"
        if a >= 1000:
            return sign + "$" + fixed(a / 1000, 1) + "K"
        if a >= 1 or a == 0:
            return sign + "$" + fixed(a, 0)
        return sign + "$" + fixed(a, 4)
    return sign + comma(int(a + 0.5))

def fmt_period(period, step):
    """A period key in words: "Oct 8", "Week to Oct 3", "Sep 2026"."""
    parts = (period or "").split("-")
    if len(parts) != 3:
        return ""
    month = MONTHS[int(parts[1], 10) - 1]
    if step == "month":
        return month + " " + parts[0]
    day = month + " " + str(int(parts[2], 10))
    return "Week to " + day if step == 7 else day

def fetch(slug):
    res = http.get(API + slug, ttl_seconds = TTL_SECONDS, headers = {"Accept": "application/json"})
    if res.status_code != 200:
        return None
    return json.decode(res.body())

def reading(ticker, value, period):
    """One number: the ticker in plum, the number, its period (capitals read better in a 4 by 6 font). A line wider than the panel scrolls."""
    return render.Padding(
        pad = (1, 1, 1, 0),
        child = render.Column(
            expanded = True,
            main_align = "space_between",
            children = [
                render.Marquee(width = 62, child = render.Text("$" + ticker, font = "tb-8", color = PLUM)),
                render.Marquee(width = 62, child = render.Text(value, font = "terminus-12", color = BONE)),
                render.Marquee(width = 62, child = render.Text(period.upper(), font = "tom-thumb", color = STONE)),
            ],
        ),
    )

def kind_of(ticker, unit):
    if unit == "dollars" or ticker in DOLLARS:
        return "dollars"
    if unit == "percent" or ticker in PERCENT:
        return "percent"
    return "count"

def step_of(ticker):
    if ticker in MONTHLY:
        return "month"
    if ticker in WEEKLY:
        return 7
    return 1

def main(config):
    slug = config.str("index", "close")
    data = fetch(slug)
    if data == None:
        return render.Root(child = reading("TICKERZ", "--", "No reading"))

    if slug == "close":
        # The Close: each of its numbers in turn, two and a half seconds each.
        frames = []
        for row in data.get("rows", []):
            t = row.get("ticker", "")
            frames.append(reading(t, fmt_value(row.get("value"), kind_of(t, None)), fmt_period(row.get("period"), step_of(t))))
        if not frames:
            return render.Root(child = reading("TICKERZ", "--", "No reading"))
        return render.Root(delay = 2500, child = render.Animation(children = frames))

    # One index: its newest complete reading, never a day still being counted.
    latest = data.get("latest_complete") or {}
    t = data.get("ticker", slug.upper())
    value = fmt_value(latest.get("value"), kind_of(t, data.get("unit")))
    return render.Root(delay = 60, child = reading(t, value, fmt_period(latest.get("period"), data.get("step"))))

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Dropdown(
                id = "index",
                name = "Index",
                desc = "The Close cycles through the day's six daily numbers. Or pick one index.",
                icon = "chartLine",
                default = "close",
                options = [schema.Option(display = d, value = v) for d, v in INDEXES],
            ),
        ],
    )
