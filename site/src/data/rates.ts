import { useEffect, useState } from 'react';
import type { Crash } from '../data';
import type { CountsByMonth, ExposureRow, LagCurve, MonthCounts } from '../lib/metrics';
import { CITY_REGION_BY_KEY, normCity, normState } from '../lib/cities';
import { isRiderOnlyProgram, operatorClass, scopeOf, type OperatorClass, type Scope } from '../lib/scope';

export { scopeOf, regionRateBlock } from '../lib/scope';

// Loaders and scope helpers for the Rates tab. narratives.json is deliberately not loaded here.

export type CountRow = { program: string; company: string; month: string; file: string } & MonthCounts;
export type EventRow = {
  date: string; date_precision: string; company: string; program: string; type: string; label: string; source_ids: string[];
};
export type SourceRow = {
  source_id: string; publisher: string; title: string; url: string; published: string; date_range: string;
  methodology: string; caveats: string; locator: string;
};
export type CompanyRow = {
  company: string; program: string; region: string; period: string; period_type: string; metric: string; value: number;
  unit: string; window: string; source_id: string; method_note: string; source_ids: string[];
};

export type InvestigationRow = {
  investigation_id: string; company: string; type: string; subject: string; opened: string; closed: string | null;
  status: string; url: string; vehicles_covered: number | null; source_ids: string[];
};

/** lag.json: whole-month completeness per program and regime, plus late-report histograms by severity. */
export type LagFile = {
  months: number[];
  pooled: boolean;
  note: string;
  regimes: Record<string, string>;
  last_submission_month: Record<string, string>;
  programs: Record<string, {
    n: number;
    n_reports: number;
    regimes: Partial<Record<'pre' | 'post', { n: number; cdf: number[]; raw_cdf: number[]; beyond_horizon: number }>>;
    /** Report counts by lag month 0..12 and a last bin for later, per regime and severity. */
    hist: Partial<Record<'pre' | 'post', Record<string, number[]>>>;
  }>;
};

export type RatesData = {
  lagFile: LagFile;
  investigations: InvestigationRow[];
  exposure: ExposureRow[];
  countRows: CountRow[];
  lag: Record<string, LagCurve>;
  events: EventRow[];
  sources: Record<string, SourceRow>;
  company: CompanyRow[];
  lastMonth: string;
  entities: string[];
};

const base = import.meta.env.BASE_URL;
async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${base}data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

let cache: Promise<RatesData> | null = null;
export function loadRatesData(): Promise<RatesData> {
  cache ??= Promise.all([
    getJson<{ rows: ExposureRow[] }>('exposure.json'),
    getJson<{ rows: CountRow[] }>('counts.json'),
    getJson<LagFile>('lag.json'),
    getJson<{ rows: EventRow[] }>('events.json'),
    getJson<{ rows: SourceRow[] }>('sources.json'),
    getJson<{ rows: CompanyRow[] }>('company_reported.json'),
    getJson<{ last_month: string; entities: string[] }>('meta.json'),
    getJson<{ rows: InvestigationRow[] }>('investigations.json'),
  ]).then(([e, c, l, ev, s, co, meta, inv]) => ({
    investigations: inv.rows,
    exposure: e.rows,
    countRows: c.rows,
    lag: Object.fromEntries(
      Object.entries(l.programs).map(([k, v]) => [k, { months: l.months, pre: v.regimes.pre?.cdf ?? null, post: v.regimes.post?.cdf ?? null }]),
    ),
    lagFile: l,
    events: ev.rows,
    sources: Object.fromEntries(s.rows.map((r) => [r.source_id, r])),
    company: co.rows,
    lastMonth: meta.last_month,
    entities: meta.entities,
  }));
  return cache;
}

export function useRatesData(): { rates: RatesData | null; error: string | null } {
  const [rates, setRates] = useState<RatesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadRatesData().then(setRates, (e) => setError(String(e)));
  }, []);
  return { rates, error };
}

let invCache: Promise<InvestigationRow[]> | null = null;
/** investigations.json alone (7 KB), for views that do not need the rest of the rates data. */
export function useInvestigations(): InvestigationRow[] {
  const [rows, setRows] = useState<InvestigationRow[]>([]);
  useEffect(() => {
    invCache ??= getJson<{ rows: InvestigationRow[] }>('investigations.json').then((r) => r.rows);
    invCache.then(setRows, () => setRows([]));
  }, []);
  return rows;
}

// ---- region scopes ----

export function regionLabel(region: string): string {
  const named: Record<string, string> = {
    us: 'United States',
    north_america: 'North America (includes Canada miles)',
    global: 'Worldwide (no US denominator)',
    ca: 'California DMV testing (miles only, no rate)',
    'city:phoenix': 'Phoenix metro',
    'city:los_angeles': 'Los Angeles area',
    'city:san_francisco': 'San Francisco',
    'city:sf_bay_area': 'San Francisco Bay Area',
    'city:austin': 'Austin',
    'city:atlanta': 'Atlanta',
  };
  return named[region] ?? region.replace('city:', '').replace(/_/g, ' ');
}

const EMPTY = (): MonthCounts => ({ crashes: 0, robust_crashes: 0, reports: 0, fatal: 0, serious_plus: 0, injury: 0, vru: 0 });

export type CountOpts = {
  /** Count only crashes with no in-vehicle operator for programs whose miles are rider-only (default true). */
  riderOnly?: boolean;
};

const inScope = (c: Crash, scope: Scope): boolean => {
  if (!('state' in scope)) return true;
  if (normState(c.state) !== scope.state) return false;
  if (scope.cities) return new Set(scope.cities.map((x) => normCity(x))).has(normCity(c.city));
  return true;
};

/**
 * Monthly counts for a program, restricted to the crash scope that matches `region`.
 * Returns null when the region has no crash scope (not mapped): the caller must show "no rate: region not mapped", never 0.
 * Counts come from counts.json when nothing needs filtering, otherwise from the program-level records
 * (one row per program and incident, which add up to the same totals).
 */
export function scopedCounts(
  countRows: CountRow[],
  crashes: Crash[],
  program: string,
  region: string,
  opts: CountOpts = {},
): CountsByMonth | null {
  const riderOnly = (opts.riderOnly ?? true) && isRiderOnlyProgram(program);
  const out: CountsByMonth = {};
  const add = (month: string, d: Partial<MonthCounts>) => {
    const c = (out[month] ??= EMPTY());
    for (const k of Object.keys(d) as (keyof MonthCounts)[]) c[k] += d[k] ?? 0;
  };
  const isEntity = program.startsWith('entity:');
  const scope = isEntity ? { all: true as const } : scopeOf(region);
  if (!scope) return null;
  if (!isEntity && 'all' in scope && !riderOnly) {
    for (const r of countRows) {
      if (r.program === program)
        add(r.month, { crashes: r.crashes, robust_crashes: r.robust_crashes ?? 0, reports: r.reports, fatal: r.fatal, serious_plus: r.serious_plus, injury: r.injury, vru: r.vru });
    }
    return out;
  }
  const entity = isEntity ? program.slice(7) : null;
  const seen = new Set<string>(); // an entity can file in two programs for one incident: count the incident once
  for (const c of crashes) {
    if (!c.month) continue;
    if (entity ? !c.entities.includes(entity) : c.program !== program) continue;
    if (!inScope(c, scope)) continue;
    if (riderOnly && operatorClass(c.operator) !== 'driverless') continue;
    if (entity) {
      const key = c.month + '|' + c.incident_key;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const sev = c.severity;
    add(c.month, {
      crashes: 1,
      robust_crashes: c.robust ? 1 : 0,
      reports: c.n_reports,
      fatal: sev === 'fatal' ? 1 : 0,
      serious_plus: sev === 'serious' || sev === 'fatal' ? 1 : 0,
      injury: sev === 'minor' || sev === 'moderate' || sev === 'serious' || sev === 'fatal' ? 1 : 0,
      vru: c.tags.some((t) => t.startsWith('vru:')) ? 1 : 0,
    });
  }
  return out;
}

export type Excluded = Record<string, { in_vehicle: number; other: number }>;

/** Per month, the crashes left out of a rider-only program's numerator (in-vehicle operator, or an operator type that is not none/remote). */
export function excludedByMonth(crashes: Crash[], program: string, region: string): Excluded {
  const out: Excluded = {};
  const scope = scopeOf(region);
  if (!scope || !isRiderOnlyProgram(program)) return out;
  for (const c of crashes) {
    if (!c.month || c.program !== program || !inScope(c, scope)) continue;
    const cls: OperatorClass = operatorClass(c.operator);
    if (cls === 'driverless') continue;
    const e = (out[c.month] ??= { in_vehicle: 0, other: 0 });
    if (cls === 'in_vehicle') e.in_vehicle++;
    else e.other++;
  }
  return out;
}

/** Sum of the excluded crashes over a set of months. */
export function sumExcluded(ex: Excluded, months: string[]): { in_vehicle: number; other: number } {
  const t = { in_vehicle: 0, other: 0 };
  for (const m of new Set(months)) {
    t.in_vehicle += ex[m]?.in_vehicle ?? 0;
    t.other += ex[m]?.other ?? 0;
  }
  return t;
}
