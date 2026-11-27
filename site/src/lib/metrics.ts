import { ci95 } from './poisson';
import { mpvAssumed, type Scenario } from '../state/scenario';
import { MILES_ONLY_REASON, regionRateBlock, unmappedReason } from './scope';

// Rates are always scope-matched: the numerator (crashes) must cover the same region and the same
// months as the denominator (exposure). Missing or zero exposure gives a null rate with a reason,
// never 0 or Infinity.

export type Metric = 'per1k' | 'perM' | 'per10kVeh' | 'milesPerCrash' | 'milesPerVehicle' | 'count';
export type Grain = 'year' | 'month';
export type Kind = 'reported' | 'derived' | 'estimate';
export type Measure = 'crashes' | 'fatal' | 'serious_plus' | 'injury' | 'vru';

export type MonthCounts = {
  crashes: number;
  reports: number;
  fatal: number;
  serious_plus: number;
  injury: number;
  vru: number;
};
export type CountsByMonth = Record<string, MonthCounts>;

export type ExposureRow = {
  program: string;
  period: string;
  region: string;
  metric: string;
  value: number;
  kind: Kind;
  source_ids: string[];
  method: string;
};

export type LagCurve = { days: number[]; cdf: number[] } | null | undefined;

export type SeriesOpts = {
  program: string;
  region: string;
  metric: Metric;
  grain: Grain;
  /** Year shown at monthly grain (default: year of lastMonth). */
  year?: number;
  /** First year at annual grain (default 2019). */
  firstYear?: number;
  /** Last month with NHTSA data, "YYYY-MM". */
  lastMonth: string;
  /** Numerator: all crashes (default) or a severity / pattern subset. */
  measure?: Measure;
  lag?: LagCurve;
};

export type Point = {
  period: string;
  /** Raw events counted (crashes or reports) over the months matched to the exposure. */
  k: number;
  /** After the scenario's window factor and lag adjustment. */
  kAdj: number;
  /** Denominator in its own unit (miles, or vehicles for per10kVeh); null when unusable. */
  exposure: number | null;
  exposureKind: Kind | null;
  rate: number | null;
  lo: number | null;
  hi: number | null;
  lowSample: boolean;
  scenario: boolean;
  reason?: string;
  /** Zero crashes with miles: miles per crash is only a lower bound (lo). */
  lowerBound?: boolean;
  months: string[];
  partial: boolean;
  sourceIds: string[];
  method: string;
  /** Method note on the exposure behind this point when the pipeline marks its monthly split as unreliable (>3x adjacent segments). */
  flag: string | null;
  /** What the right-hand "volume" axis shows for this point (may exist even when the rate is null). */
  volume: number | null;
  volumeUnit: 'miles' | 'vehicles';
  /** The denominator rests on an assumption the user set (miles per vehicle, or a US share of subscribers). */
  assumption: boolean;
  /** What `exposure` (the denominator) is measured in. Per-vehicle rates divide by vehicle-years, not vehicles. */
  exposureUnit: 'miles' | 'vehicles' | 'vehicle-years';
  /** Months of this point whose reports are still arriving (completeness below COMPLETE_SHARE): the count is probably low. */
  incomplete: string[];
  notes: string[];
};

export const SGO_START = '2021-07';
export const BREAK_DATE = '2025-06-16';

const KIND_RANK: Record<Kind, number> = { reported: 0, derived: 1, estimate: 2 };
const worstKind = (ks: Kind[]): Kind => ks.reduce((a, b) => (KIND_RANK[b] > KIND_RANK[a] ? b : a), 'reported' as Kind);

/** A month counts as complete once at least this share of its reports has usually been filed (lag.json CDF). */
export const COMPLETE_SHARE = 0.9;
export const INCOMPLETE_LABEL = 'recent months are incomplete (late reports expected)';

export const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthsOfYear = (y: number) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

/** Share of reports filed within `days` of the incident month (linear interpolation, clamped). */
export function cdfAt(lag: LagCurve, days: number): number | null {
  if (!lag || lag.days.length === 0) return null;
  const { days: d, cdf } = lag;
  if (days <= d[0]) return cdf[0];
  if (days >= d[d.length - 1]) return cdf[cdf.length - 1];
  for (let i = 1; i < d.length; i++) {
    if (days <= d[i]) {
      const t = (days - d[i - 1]) / (d[i] - d[i - 1]);
      return cdf[i - 1] + t * (cdf[i] - cdf[i - 1]);
    }
  }
  return cdf[cdf.length - 1];
}

/** True when a month's reports are still arriving: its age's share of reports filed is below COMPLETE_SHARE (or it is under 2 months old without a lag curve). */
export function monthIncomplete(lag: LagCurve, month: string, lastMonth: string): boolean {
  const age = monthIndex(lastMonth) - monthIndex(month);
  if (age < 0) return false;
  const frac = cdfAt(lag, 30 * age);
  return frac != null ? frac < COMPLETE_SHARE : age < 2;
}

/** Multiplier applied to a month's count because late reports have not arrived yet. */
export function lagFactor(lag: LagCurve, month: string, lastMonth: string, multiplier: number): number {
  const age = monthIndex(lastMonth) - monthIndex(month);
  if (age < 0) return 1;
  const frac = cdfAt(lag, 30 * age);
  if (frac == null) return 1;
  return 1 + (1 / Math.max(frac, 0.05) - 1) * multiplier;
}

type Resolved = {
  value: number | null;
  kind: Kind | null;
  months: string[];
  partial: boolean;
  sourceIds: string[];
  method: string;
  scenario: boolean;
  reason?: string;
  flag?: string | null;
};

/**
 * Exposure rows whose method text carries "Note: adjacent disclosure segments differ by >3×; ... the monthly split is unreliable."
 * (interpolated or differenced miles across very uneven disclosures). Returns the note, or null.
 */
export function methodFlag(method: string | null | undefined): string | null {
  const m = /Note: ([^.]*>\s*3\s*[×x][^.]*\.)/.exec(method ?? '');
  if (!m) return null;
  const t = m[1].trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const NONE = (reason: string, months: string[] = []): Resolved => ({
  value: null, kind: null, months, partial: false, sourceIds: [], method: '', scenario: false, reason,
});

type PeriodInfo = { grain: Grain; period: string; monthsAll: string[]; complete: boolean };

/** Pick or aggregate the exposure rows that cover a period. `agg`: miles are flows (sum), vehicles are stocks (mean). */
function resolveRows(rows: ExposureRow[], p: PeriodInfo, agg: 'sum' | 'mean', label: string): Resolved {
  if (p.grain === 'month') {
    const r = rows.find((x) => x.period === p.period);
    if (!r) return NONE(`No monthly ${label} disclosed for ${p.period}.`);
    return { value: r.value, kind: r.kind, months: [p.period], partial: false, sourceIds: r.source_ids, method: r.method, scenario: false, flag: methodFlag(r.method) };
  }
  const annual = rows.find((x) => x.period === p.period);
  if (annual && (agg === 'mean' || p.complete)) {
    return {
      value: annual.value, kind: annual.kind, months: p.monthsAll, partial: !p.complete,
      sourceIds: annual.source_ids, method: annual.method, scenario: false, flag: methodFlag(annual.method),
    };
  }
  const monthly = rows.filter((x) => x.period.length === 7 && p.monthsAll.includes(x.period));
  if (monthly.length === 0) return NONE(`No ${label} disclosed for ${p.period}.`);
  const sum = monthly.reduce((a, r) => a + r.value, 0);
  const months = monthly.map((r) => r.period).sort();
  return {
    value: agg === 'sum' ? sum : sum / monthly.length,
    kind: worstKind(monthly.map((r) => r.kind)),
    months,
    partial: months.length !== p.monthsAll.length || !p.complete,
    sourceIds: [...new Set(monthly.flatMap((r) => r.source_ids))],
    method: `${agg === 'sum' ? 'Sum' : 'Mean'} of ${monthly.length} monthly rows (${months[0]} to ${months[months.length - 1]}). ${monthly[0].method}`,
    scenario: false,
    flag: monthly.map((r) => methodFlag(r.method)).find((x) => x) ?? null,
  };
}

const sumCount = (counts: CountsByMonth, months: string[], pick: (c: MonthCounts) => number, w: (m: string) => number) => {
  let raw = 0;
  let adj = 0;
  for (const m of months) {
    const c = counts[m];
    if (!c) continue;
    const v = pick(c);
    raw += v;
    adj += v * w(m);
  }
  return [raw, adj] as const;
};

export function metricNeeds(metric: Metric): 'miles' | 'vehicles' | 'both' | 'none' {
  if (metric === 'per10kVeh') return 'vehicles';
  if (metric === 'milesPerVehicle') return 'both';
  if (metric === 'count') return 'none';
  return 'miles';
}

/**
 * One Point per period. `counts` null means the region has no crash scope (not mapped): every rate is then null with a reason,
 * never 0. Regions that can never give a rate (California DMV testing miles, worldwide) keep their exposure as an informational
 * volume only.
 */
export function series(counts: CountsByMonth | null, exposure: ExposureRow[], scenario: Scenario, opts: SeriesOpts): Point[] {
  const { program, region, metric, grain, lastMonth } = opts;
  const block = regionRateBlock(region);
  const countsIn: CountsByMonth = counts ?? {};
  const measure: Measure = opts.measure ?? 'crashes';
  const lastYear = Number(lastMonth.slice(0, 4));
  const year = opts.year ?? lastYear;
  const rowsFor = (reg: string, m: string) => exposure.filter((r) => r.program === program && r.region === reg && r.metric === m);
  const milesRows = rowsFor(region, 'miles');
  const vehRows = rowsFor(region, 'active_vehicles');
  const isTesla = program === 'tesla_l2';
  const useSubs = isTesla && region === 'us' && scenario.teslaDenominator === 'subscribers';
  const subsRows = rowsFor('global', 'subscribers');

  const periods: PeriodInfo[] = [];
  if (grain === 'year') {
    for (let y = opts.firstYear ?? 2019; y <= lastYear; y++) {
      const monthsAll = monthsOfYear(y).filter((m) => m <= lastMonth);
      periods.push({ grain, period: String(y), monthsAll, complete: monthsAll.length === 12 });
    }
  } else {
    for (const m of monthsOfYear(year).filter((m) => m <= lastMonth)) periods.push({ grain, period: m, monthsAll: [m], complete: true });
  }

  const wf = scenario.windowFactor;
  const weight = (m: string) =>
    wf * (scenario.lagAdjust ? lagFactor(opts.lag, m, lastMonth, scenario.lagMultiplier) : 1);
  const pick = (c: MonthCounts) => (measure === 'crashes' ? (scenario.countBy === 'reports' ? c.reports : c.crashes) : c[measure]);

  const vehicles = (p: PeriodInfo): Resolved => {
    if (useSubs) {
      const r = resolveRows(subsRows, p, 'mean', 'worldwide FSD subscribers');
      if (r.value == null) return r;
      return {
        ...r, value: r.value * scenario.subsUsShare, kind: 'estimate', scenario: true,
        method: `Worldwide FSD subscribers x an assumed US share of ${(scenario.subsUsShare * 100).toFixed(0)}% (your assumption). ${r.method}`,
      };
    }
    return resolveRows(vehRows, p, 'mean', 'active vehicles');
  };

  const out: Point[] = [];
  for (const p of periods) {
    const needs = metricNeeds(metric);
    const notes: string[] = [];
    let miles: Resolved = NONE('');
    let veh: Resolved = NONE('');
    if (needs !== 'vehicles' && needs !== 'none') {
      miles = resolveRows(milesRows, p, 'sum', 'miles');
      // No miles at all in this region for this program: derive from vehicles x an assumed miles/vehicle/year,
      // but only when the user has set that assumption. There is no default, so nothing is derived from an invented number.
      if (milesRows.length === 0 && (vehRows.length > 0 || useSubs) && needs === 'miles') {
        const mpv = mpvAssumed(scenario, program);
        const v = vehicles(p);
        if (mpv == null) {
          miles = NONE(`No miles are disclosed for ${program} in region ${region}. Set a miles-per-vehicle assumption in the scenario panel to see an assumption-based series.`);
        } else if (v.value == null) miles = v;
        else {
          const months = v.months.length;
          miles = {
            value: v.value * mpv * (months / 12), kind: 'estimate', months: v.months, partial: v.partial,
            sourceIds: v.sourceIds, scenario: true,
            method: `Derived: ${Math.round(v.value).toLocaleString('en-US')} vehicles x ${mpv.toLocaleString('en-US')} miles per vehicle per year (your assumption) x ${months}/12 of a year. No miles are disclosed for this program and region. ${v.method}`,
          };
          notes.push('Miles are derived from an assumed miles per vehicle per year, not disclosed.');
        }
      } else if (milesRows.length === 0) {
        miles = NONE(`No miles disclosed for ${program} in region ${region}.`);
      }
    }
    if (needs === 'vehicles' || needs === 'both') veh = vehicles(p);

    // The exposure that denominates this metric.
    let denom: Resolved;
    let volumeUnit: 'miles' | 'vehicles' = 'miles';
    if (needs === 'vehicles') {
      denom = veh;
      volumeUnit = 'vehicles';
    } else if (needs === 'none') {
      const m = resolveRows(milesRows, p, 'sum', 'miles');
      if (milesRows.length > 0) denom = m;
      else {
        denom = vehicles(p);
        volumeUnit = 'vehicles';
      }
    } else if (needs === 'both') {
      denom = miles;
      if (miles.value != null && veh.value == null) denom = { ...veh, reason: veh.reason };
      else if (miles.value != null && miles.scenario) denom = NONE('Miles per vehicle needs disclosed miles; here miles come from an assumed miles per vehicle.');
    } else denom = miles;

    // Numerator over the months the exposure covers.
    const months = denom.value != null ? denom.months : p.monthsAll;
    const [k, kAdj] = sumCount(countsIn, months, pick, weight);
    const [kAll] = sumCount(countsIn, p.monthsAll, pick, () => 1);

    const base: Point = {
      period: p.period, k: denom.value != null ? k : kAll, kAdj: denom.value != null ? kAdj : kAll * wf,
      exposure: null, exposureKind: denom.kind, rate: null, lo: null, hi: null,
      lowSample: true, scenario: false, months, partial: denom.partial,
      sourceIds: denom.sourceIds, method: denom.method, flag: denom.flag ?? null, volume: denom.value, volumeUnit, notes,
      exposureUnit: volumeUnit,
      assumption: denom.scenario,
      incomplete: months.filter((m) => monthIncomplete(opts.lag, m, lastMonth)),
    };
    const numScenario =
      wf !== 1 || (scenario.countBy !== 'crashes' && measure === 'crashes') || (scenario.lagAdjust && months.some((m) => weight(m) !== wf));
    base.scenario = numScenario || denom.scenario;
    if (denom.scenario && notes.length === 0) notes.push('Uses a user assumption, not a disclosed number.');
    if (wf !== 1) notes.push(`SGO counts scaled by your window factor ${wf}.`);
    if (scenario.lagAdjust) notes.push('Recent months adjusted for late reports.');
    if (denom.partial && denom.value != null) notes.push(`Partial period: ${months.length} month(s) with exposure, crashes counted over the same months.`);

    const finish = (reason: string): Point => ({ ...base, reason, lowSample: true });

    // Count metric: no denominator needed.
    if (metric === 'count') {
      if (counts == null) { out.push(finish(unmappedReason(region))); continue; }
      const [k0, k1] = sumCount(countsIn, p.monthsAll, pick, weight);
      const [lo0, hi0] = ci95(k0);
      const s = k0 > 0 ? k1 / k0 : wf;
      out.push({
        ...base, k: k0, kAdj: k1, months: p.monthsAll, exposure: denom.value, rate: k1, lo: lo0 * s, hi: hi0 * s,
        incomplete: p.monthsAll.filter((m) => monthIncomplete(opts.lag, m, lastMonth)),
        lowSample: k0 < 10, exposureKind: denom.kind, reason: undefined,
        scenario: numScenario,
      });
      continue;
    }

    if (p.grain === 'year' && Number(p.period) < 2021) { out.push(finish('SGO reporting began 2021-07.')); continue; }
    if (p.grain === 'month' && p.period < SGO_START) { out.push(finish('SGO reporting began 2021-07.')); continue; }
    if (block === 'global') { out.push(finish('Global-region exposure is never a US denominator: no US denominator.')); continue; }
    if (block === 'miles-only') { out.push(finish(MILES_ONLY_REASON)); continue; }
    if (block === 'unmapped' || counts == null) { out.push(finish(unmappedReason(region))); continue; }
    if (denom.value == null) { out.push(finish(denom.reason || 'No exposure disclosed.')); continue; }
    if (!(denom.value > 0)) { out.push(finish('Exposure is zero or missing: no denominator.')); continue; }
    if (p.grain === 'year' && p.period === '2021' && !denom.partial && denom.months.length === 12) {
      out.push(finish('SGO covers Jul-Dec 2021 only but the exposure is for the full year.')); continue;
    }
    if (denom.reason) { out.push(finish(denom.reason)); continue; }

    const E = denom.value;
    const [lo0, hi0] = ci95(base.k);
    const s = base.k > 0 ? base.kAdj / base.k : wf;
    const loK = lo0 * s;
    const hiK = hi0 * s;
    const lowSample = base.k < 10 || denom.kind === 'estimate' || denom.scenario;
    const pt: Point = { ...base, exposure: E, lowSample };

    if (metric === 'per10kVeh') {
      // Crashes per 10,000 vehicle-YEARS: the denominator is vehicles x (months covered / 12) and the numerator was
      // counted over those same months, so a partial year is not mistaken for a safer one.
      const years = denom.months.length / 12;
      const vy = E * years;
      pt.exposure = vy;
      pt.exposureUnit = 'vehicle-years';
      pt.rate = (base.kAdj / vy) * 1e4;
      pt.lo = (loK / vy) * 1e4;
      pt.hi = (hiK / vy) * 1e4;
      if (denom.partial || denom.months.length !== 12) {
        pt.notes = [...pt.notes, `Partial period: ${denom.months.length} of 12 months, so the rate is crashes per vehicle-year over those months (not comparable with a full year without that in mind).`];
      }
    } else if (metric === 'per1k' || metric === 'perM') {
      const f = metric === 'per1k' ? 1e3 : 1e6;
      pt.rate = (base.kAdj / E) * f;
      pt.lo = (loK / E) * f;
      pt.hi = (hiK / E) * f;
    } else if (metric === 'milesPerCrash') {
      if (base.kAdj > 0) {
        pt.rate = E / base.kAdj;
        pt.lo = E / hiK;
        pt.hi = loK > 0 ? E / loK : null;
      } else {
        pt.lo = E / hiK;
        pt.lowerBound = true;
        pt.reason = `More than ${Math.round(E / hiK).toLocaleString('en-US')} miles per crash (0 crashes): lower bound only.`;
      }
    } else if (metric === 'milesPerVehicle') {
      const v = veh.value;
      if (v == null || !(v > 0)) {
        pt.exposure = null;
        pt.reason = veh.reason || 'No active-vehicle count for this period.';
      } else {
        // Annualized: miles over the months covered, divided by the mean fleet, scaled to twelve months.
        pt.rate = (E / v) * (12 / Math.max(1, denom.months.length));
        pt.notes = [...pt.notes, denom.months.length === 12 ? 'Miles per vehicle per year.' : `Annualized from ${denom.months.length} month(s): miles per vehicle x 12 / ${denom.months.length}.`];
        pt.exposureKind = worstKind([denom.kind ?? 'reported', veh.kind ?? 'reported']);
        pt.lowSample = pt.exposureKind === 'estimate';
        pt.notes = [...pt.notes, 'Miles per vehicle is a ratio of two disclosures; no Poisson interval applies.'];
        pt.sourceIds = [...new Set([...denom.sourceIds, ...veh.sourceIds])];
      }
    }
    out.push(pt);
  }
  return out;
}

/** Regions of a program ordered us, north_america, then cities, with miles-only (ca) and global after them. */
export function regionsFor(exposure: ExposureRow[], program: string): string[] {
  const set = new Set(exposure.filter((r) => r.program === program && r.metric !== 'recall_units').map((r) => r.region));
  const rank = (r: string) => (r === 'us' ? 0 : r === 'north_america' ? 1 : r.startsWith('city:') ? 2 : r === 'ca' ? 3 : 4);
  return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
