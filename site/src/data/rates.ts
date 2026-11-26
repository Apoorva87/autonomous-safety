import { useEffect, useState } from 'react';
import type { Crash } from '../data';
import type { CountsByMonth, ExposureRow, LagCurve, MonthCounts } from '../lib/metrics';
import { CITY_REGION_BY_KEY } from '../lib/cities';

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

export type RatesData = {
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
    getJson<{ days: number[]; programs: Record<string, { cdf: number[] }> }>('lag.json'),
    getJson<{ rows: EventRow[] }>('events.json'),
    getJson<{ rows: SourceRow[] }>('sources.json'),
    getJson<{ rows: CompanyRow[] }>('company_reported.json'),
    getJson<{ last_month: string; entities: string[] }>('meta.json'),
    getJson<{ rows: InvestigationRow[] }>('investigations.json'),
  ]).then(([e, c, l, ev, s, co, meta, inv]) => ({
    investigations: inv.rows,
    exposure: e.rows,
    countRows: c.rows,
    lag: Object.fromEntries(Object.entries(l.programs).map(([k, v]) => [k, { days: l.days, cdf: v.cdf }])),
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

type Scope = { all: true } | { state: string; cities?: string[] };

/** The crash scope that matches an exposure region. null = the region cannot be matched to NHTSA crashes. */
export function scopeOf(region: string): Scope | null {
  switch (region) {
    case 'us':
    case 'north_america':
      return { all: true };
    case 'ca':
      return { state: 'CA' };
    default: {
      const r = CITY_REGION_BY_KEY[region];
      return r ? { state: r.state, cities: r.cities } : null;
    }
  }
}

export function regionLabel(region: string): string {
  const named: Record<string, string> = {
    us: 'United States',
    north_america: 'North America (includes Canada miles)',
    global: 'Worldwide (no US denominator)',
    ca: 'California only',
    'city:phoenix': 'Phoenix metro',
    'city:los_angeles': 'Los Angeles area',
    'city:san_francisco': 'San Francisco',
    'city:sf_bay_area': 'San Francisco Bay Area',
    'city:austin': 'Austin',
    'city:atlanta': 'Atlanta',
  };
  return named[region] ?? region.replace('city:', '').replace(/_/g, ' ');
}

const EMPTY = (): MonthCounts => ({ crashes: 0, reports: 0, fatal: 0, serious_plus: 0, injury: 0, vru: 0 });

/** Monthly counts for a program, restricted to the crash scope that matches `region`. */
export function scopedCounts(
  countRows: CountRow[],
  crashes: Crash[],
  program: string,
  region: string,
): CountsByMonth {
  const out: CountsByMonth = {};
  const add = (month: string, d: Partial<MonthCounts>) => {
    const c = (out[month] ??= EMPTY());
    for (const k of Object.keys(d) as (keyof MonthCounts)[]) c[k] += d[k] ?? 0;
  };
  const isEntity = program.startsWith('entity:');
  const scope = isEntity ? { all: true as const } : scopeOf(region);
  if (!isEntity && scope && 'all' in scope) {
    for (const r of countRows) {
      if (r.program === program) add(r.month, r);
    }
    return out;
  }
  if (!scope) return out;
  const entity = isEntity ? program.slice(7) : null;
  const cities = 'cities' in scope && scope.cities ? new Set(scope.cities.map((c) => c.toLowerCase())) : null;
  for (const c of crashes) {
    if (!c.month) continue;
    if (entity ? c.entity !== entity : c.program !== program) continue;
    if ('state' in scope) {
      if ((c.state ?? '').trim().toUpperCase() !== scope.state) continue;
      if (cities && !cities.has((c.city ?? '').trim().toLowerCase())) continue;
    }
    const sev = c.severity;
    add(c.month, {
      crashes: 1,
      reports: c.n_reports,
      fatal: sev === 'fatal' ? 1 : 0,
      serious_plus: sev === 'serious' || sev === 'fatal' ? 1 : 0,
      injury: sev === 'minor' || sev === 'moderate' || sev === 'serious' || sev === 'fatal' ? 1 : 0,
      vru: c.tags.some((t) => t.startsWith('vru:')) ? 1 : 0,
    });
  }
  return out;
}
