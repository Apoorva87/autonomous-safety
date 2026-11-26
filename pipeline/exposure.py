"""Normalize the hand-curated exposure rows into annual and monthly series (exposure.json).

normalize(rows, today) takes the rows of the golden `exposure` table (manual.load
output: one row per disclosure, in whatever period type the source used) and
returns (rows, warnings). Output rows are

    {program, period "YYYY" | "YYYY-MM", region, metric, value, kind, source_ids, method}

with metric one of miles, active_vehicles, subscribers or recall_units. One series
is one (program, region, metric): a US denominator and a California-only one are
never mixed. Every output row names its sources and says how it was computed.

Rules (ruling R2):
  miles, year rows       passed through unchanged.
  miles, quarter rows    four quarters sum to the year; kind is the weakest
                         component (reported < derived < estimate). A year with
                         only some quarters is extrapolated (mean of the present
                         quarters x 4), marked estimate, and says so in `method`.
  cum_miles              cumulative disclosures become period deltas between
                         disclosure dates (derived, with the sources of both
                         ends). Months and years take the share of the delta that
                         falls in them, spreading each delta evenly over its days
                         (linear interpolation of the cumulative curve). A month
                         is `derived` only when both of its boundary dates are
                         disclosure dates, otherwise `estimate`; a year likewise.
                         Interpolated rows name the gap between the bracketing disclosures; a gap
                         over LOW_CONFIDENCE_GAP_DAYS is labelled "low confidence" (kind stays estimate).
                         A period that starts before the first disclosure or ends
                         after the last one gets no row: nothing is extrapolated.
                         Two adjacent segments whose daily rates differ by more than
                         RATE_JUMP (3x) usually mean a rounded milestone ("more than
                         800M"): the months overlapping the shorter of the two get
                         RATE_JUMP_NOTE in `method` and a warning names them. Values
                         and annual rows are unchanged.
  active_vehicles,       the mean of the observations dated inside the period (kind derived
                         when it averages several observations; a single one keeps its kind).
  subscribers            With none, the latest earlier observation is carried
                         forward (kind estimate, "carried forward from <date>")
                         for at most CARRY_MONTHS months: the whole period must
                         end within 12 months of the observation.
  recall_units           a recall's "potential units affected", reported as its
                         own metric by month. It is never a fleet size.

Zero, negative or missing values produce no row (a rate on them would be 0 or
infinite). Months run from the first disclosure to the month of `today`, years
from FIRST_YEAR to the year of `today`.
"""
import calendar
import datetime
import math
from collections import defaultdict

KIND_RANK = {"reported": 0, "derived": 1, "estimate": 2}
CARRY_MONTHS = 12
LOW_CONFIDENCE_GAP_DAYS = 540
RATE_JUMP = 3  # adjacent cum_miles segments whose daily rates differ by more than this are flagged
RATE_JUMP_NOTE = (
    "Note: adjacent disclosure segments differ by >3\u00d7; disclosures are rounded milestones, so the monthly "
    "split is unreliable."
)
FIRST_YEAR = 2019
STOCK_METRICS = ("active_vehicles", "subscribers")


# ---------------------------------------------------------------- small helpers
def weakest(kinds):
    """The least certain of several kinds."""
    return max(kinds, key=KIND_RANK.__getitem__)


def _month_end(year, month):
    return datetime.date(year, month, calendar.monthrange(year, month)[1])


def _add_months(day, months):
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    return datetime.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _period_end(period, period_type):
    """Last day a disclosure's period covers."""
    year = int(period[:4])
    if period_type == "year":
        return datetime.date(year, 12, 31)
    if period_type == "quarter":
        return _month_end(year, 3 * int(period[-1]))
    if period_type == "month":
        return _month_end(year, int(period[5:7]))
    return datetime.date.fromisoformat(period)


def _number(value):
    """A finite value above zero, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and value > 0 else None


def _round(value):
    return int(round(value)) if value >= 1 else round(value, 6)


def _union(lists):
    seen = []
    for ids in lists:
        for sid in ids:
            if sid not in seen:
                seen.append(sid)
    return seen


def _out(program, region, metric, period, value, kind, source_ids, method):
    return {
        "program": program, "period": period, "region": region, "metric": metric,
        "value": _round(value), "kind": kind, "source_ids": list(source_ids), "method": method,
    }


def _months(first, last):
    """(year, month) from first to last inclusive."""
    y, m = first
    while (y, m) <= last:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def _best(rows):
    """The most certain row (reported first); ties keep the first listed."""
    return min(rows, key=lambda r: KIND_RANK[r["kind"]])


# ------------------------------------------------------------------ flow: miles
def _direct_miles(program, region, rows, today, warnings):
    """Annual and monthly miles disclosed as year, quarter or month rows."""
    by_type = {"year": defaultdict(list), "quarter": defaultdict(list), "month": defaultdict(list)}
    for r in rows:
        if r["period_type"] not in by_type:
            warnings.append("exposure %s/%s miles %s: period type %s is not a flow period; ignored"
                            % (program, region, r["period"], r["period_type"]))
            continue
        if _number(r["value"]) is not None:
            by_type[r["period_type"]][r["period"]].append(r)
    out = {}

    def emit(period, value, kind, ids, method):
        out[period] = _out(program, region, "miles", period, value, kind, ids, method)

    for period, group in by_type["month"].items():
        r = _best(group)
        emit(period, r["value"], r["kind"], r["source_ids"], r["method_note"] or "As disclosed (month).")
    years = {p[:4] for p in by_type["quarter"]} | {p[:4] for p in by_type["month"]}
    for year in sorted(years):
        quarters = {q: _best(by_type["quarter"]["%s-Q%d" % (year, q)]) for q in range(1, 5)
                    if by_type["quarter"].get("%s-Q%d" % (year, q))}
        if quarters:
            total = sum(r["value"] for r in quarters.values())
            ids = _union(r["source_ids"] for r in quarters.values())
            if len(quarters) == 4:
                kind = weakest([r["kind"] for r in quarters.values()])
                method = "Sum of the four quarters Q1-Q4 of %s." % year
            else:
                missing = ", ".join("Q%d" % q for q in range(1, 5) if q not in quarters)
                total = total * 4 / len(quarters)
                kind = "estimate"
                method = ("Extrapolated: %s missing; mean of the %d disclosed quarter(s) x 4 (%s)."
                          % (missing, len(quarters), ", ".join("Q%d" % q for q in sorted(quarters))))
            emit(year, total, kind, ids, method)
            continue
        months = [by_type["month"].get("%s-%02d" % (year, m)) for m in range(1, 13)]
        if all(months):
            best = [_best(g) for g in months]
            emit(year, sum(r["value"] for r in best), weakest([r["kind"] for r in best]),
                 _union(r["source_ids"] for r in best), "Sum of the twelve monthly figures of %s." % year)
    for period, group in by_type["year"].items():
        r = _best(group)
        emit(period, r["value"], r["kind"], r["source_ids"], r["method_note"] or "As disclosed (year).")
    return out


def _cum_observations(rows, program, region, warnings):
    by_date = defaultdict(list)
    for r in rows:
        if r["period_type"] != "cumulative_to":
            warnings.append("exposure %s/%s cum_miles %s: period type %s is not a cumulative date; ignored"
                            % (program, region, r["period"], r["period_type"]))
            continue
        value = r["value"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            continue
        by_date[datetime.date.fromisoformat(r["period"])].append(r)
    obs = []
    for day in sorted(by_date):
        r = _best(by_date[day])
        obs.append({"date": day, "value": r["value"], "kind": r["kind"], "source_ids": r["source_ids"]})
    return obs


def _cum_miles(program, region, rows, today, warnings):
    """Monthly and annual miles from cumulative disclosures (see the module doc)."""
    obs = _cum_observations(rows, program, region, warnings)
    if len(obs) < 2:
        return {}
    segments = []
    for a, b in zip(obs, obs[1:]):
        valid = b["value"] >= a["value"]
        if not valid:
            warnings.append("exposure %s/%s cum_miles decreases from %s (%s) to %s (%s); the interval is unusable"
                            % (program, region, a["date"], a["value"], b["date"], b["value"]))
        segments.append({"start": a["date"], "end": b["date"], "delta": b["value"] - a["value"], "valid": valid,
                         "ends": (a, b)})
    first, last = obs[0]["date"], obs[-1]["date"]
    dates = {o["date"] for o in obs}

    def interval(b0, b1):
        """Miles in the days (b0, b1], or None when not fully inside the disclosed range."""
        if b0 < first or b1 > last:
            return None
        total, touched = 0.0, []
        for seg in segments:
            lo, hi = max(b0, seg["start"]), min(b1, seg["end"])
            if hi <= lo:
                continue
            if not seg["valid"]:
                return None
            total += seg["delta"] * (hi - lo).days / (seg["end"] - seg["start"]).days
            touched.append(seg)
        if not touched or total <= 0:
            return None
        ends = [o for seg in touched for o in seg["ends"]]
        exact = b0 in dates and b1 in dates
        kind = weakest([("derived" if exact else "estimate")] + [o["kind"] for o in ends])
        span = "%s to %s" % (touched[0]["start"], touched[-1]["end"])
        gaps = [(seg["end"] - seg["start"]).days for seg in touched
                if max(b0, seg["start"]) > seg["start"] or min(b1, seg["end"]) < seg["end"]]
        gap = max(gaps) if gaps else 0
        if exact:
            method = ("Derived: cumulative miles at %s minus cumulative miles at %s (difference of disclosures)."
                      % (b1, b0))
        else:
            if gap > LOW_CONFIDENCE_GAP_DAYS:
                method = ("Estimate: interpolated across a gap of %d days, low confidence. Share of the "
                          "cumulative-mile growth disclosed between %s, spread evenly over its days." % (gap, span))
            else:
                method = ("Estimate: share of the cumulative-mile growth disclosed between %s (gap of %d days "
                          "between disclosures), spread evenly over its days (linear interpolation of the "
                          "cumulative curve)." % (span, gap))
        if kind == "estimate" and exact:
            method += " An input disclosure is itself an estimate."
        return total, kind, _union(o["source_ids"] for o in ends), method

    out = {}
    for y, m in _months((first.year, first.month), (today.year, today.month)):
        prev = _month_end(y - 1, 12) if m == 1 else _month_end(y, m - 1)
        result = interval(prev, _month_end(y, m))
        if result:
            out["%04d-%02d" % (y, m)] = _out(program, region, "miles", "%04d-%02d" % (y, m), *_pack(result))
    for year in range(max(first.year, FIRST_YEAR), today.year + 1):
        result = interval(datetime.date(year - 1, 12, 31), datetime.date(year, 12, 31))
        if result:
            out[str(year)] = _out(program, region, "miles", str(year), *_pack(result))
    _flag_rate_jumps(program, region, segments, out, warnings)
    return out


def _flag_rate_jumps(program, region, segments, out, warnings):
    """Mark the monthly rows around adjacent segments whose daily rates differ by more than RATE_JUMP."""
    flagged = set()
    for a, b in zip(segments, segments[1:]):
        if not (a["valid"] and b["valid"]) or a["delta"] <= 0 or b["delta"] <= 0:
            continue
        rate_a = a["delta"] / (a["end"] - a["start"]).days
        rate_b = b["delta"] / (b["end"] - b["start"]).days
        if max(rate_a, rate_b) / min(rate_a, rate_b) <= RATE_JUMP:
            continue
        short = min((a, b), key=lambda s: ((s["end"] - s["start"]).days, s["start"]))
        for y, m in _months((short["start"].year, short["start"].month), (short["end"].year, short["end"].month)):
            period = "%04d-%02d" % (y, m)
            if period in out:
                flagged.add(period)
    for period in sorted(flagged):
        out[period]["method"] += " " + RATE_JUMP_NOTE
    if flagged:
        warnings.append(
            "exposure %s/%s cum_miles: adjacent disclosure segments differ by >%d\u00d7 in daily rate; the monthly split "
            "of %s is unreliable (disclosures are rounded milestones); annual totals are unaffected"
            % (program, region, RATE_JUMP, ", ".join(sorted(flagged))))


def _pack(result):
    total, kind, ids, method = result
    return total, kind, ids, method


# ------------------------------------------------------------ stock: vehicles etc
def _stock(program, region, metric, rows, today):
    obs_by_date = defaultdict(list)
    for r in rows:
        if _number(r["value"]) is None:
            continue
        day = min(_period_end(r["period"], r["period_type"]), today)
        obs_by_date[day].append(r)
    obs = []
    for day in sorted(obs_by_date):
        r = _best(obs_by_date[day])
        obs.append({"date": day, "value": r["value"], "kind": r["kind"], "source_ids": r["source_ids"]})
    if not obs:
        return {}

    def period_row(label, start, end):
        inside = [o for o in obs if start <= o["date"] <= end]
        if inside:
            kinds = [o["kind"] for o in inside]
            if len(inside) > 1:
                kinds.append("derived")  # an average is computed, not reported
            kind = weakest(kinds)
            ids = _union(o["source_ids"] for o in inside)
            value = sum(o["value"] for o in inside) / len(inside)
            if len(inside) == 1:
                method = "Observation of %s." % inside[0]["date"]
            else:
                method = "Mean of %d observations in the period (%s)." % (
                    len(inside), ", ".join(str(o["date"]) for o in inside))
            return _out(program, region, metric, label, value, kind, ids, method)
        earlier = [o for o in obs if o["date"] < start]
        if not earlier:
            return None
        latest = earlier[-1]
        if min(end, today) > _add_months(latest["date"], CARRY_MONTHS):
            return None
        return _out(program, region, metric, label, latest["value"], "estimate", latest["source_ids"],
                    "Estimate: carried forward from %s (%s) for up to %d months; no newer disclosure."
                    % (latest["date"], latest["kind"], CARRY_MONTHS))

    out = {}
    first = obs[0]["date"]
    for y, m in _months((first.year, first.month), (today.year, today.month)):
        label = "%04d-%02d" % (y, m)
        row = period_row(label, datetime.date(y, m, 1), _month_end(y, m))
        if row:
            out[label] = row
    for year in range(max(first.year, FIRST_YEAR), today.year + 1):
        row = period_row(str(year), datetime.date(year, 1, 1), datetime.date(year, 12, 31))
        if row:
            out[str(year)] = row
    return out


def _recalls(program, region, rows, today):
    by_month = defaultdict(list)
    for r in rows:
        if _number(r["value"]) is None:
            continue
        day = _period_end(r["period"], r["period_type"])
        by_month["%04d-%02d" % (day.year, day.month)].append(r)
    out = {}
    for period, group in by_month.items():
        kind = weakest([r["kind"] for r in group])
        note = ("NHTSA recall report: potential units affected by recall(s) filed this month; "
                "not a fleet size and not an operating population.")
        if len(group) > 1:
            note += " Sum of %d recalls." % len(group)
        out[period] = _out(program, region, "recall_units", period, sum(r["value"] for r in group), kind,
                           _union(r["source_ids"] for r in group), note)
    return out


# --------------------------------------------------------------------- normalize
def normalize(rows, today):
    """(output rows sorted by program, region, metric, period; warnings)."""
    series = defaultdict(list)
    for r in rows:
        series[(r["program"], r["region"], r["metric"])].append(r)
    warnings, out = [], []
    by_series = {}
    for (program, region, metric), group in sorted(series.items()):
        if metric == "miles":
            periods = _direct_miles(program, region, group, today, warnings)
        elif metric == "cum_miles":
            periods = {}
        elif metric in STOCK_METRICS:
            periods = _stock(program, region, metric, group, today)
        elif metric == "recall_units":
            periods = _recalls(program, region, group, today)
        else:
            warnings.append("exposure %s/%s: unknown metric %s ignored" % (program, region, metric))
            continue
        by_series[(program, region, metric)] = periods
    for (program, region, metric), group in sorted(series.items()):
        if metric != "cum_miles":
            continue
        derived = _cum_miles(program, region, group, today, warnings)
        merged = by_series.setdefault((program, region, "miles"), {})
        for period, row in derived.items():
            merged.setdefault(period, row)  # a directly disclosed figure beats a derived one
    for key in sorted(by_series):
        out.extend(by_series[key][p] for p in sorted(by_series[key]))
    return out, warnings
