import type { Crash } from '../data';
import { ci95 } from './poisson';
import type { Kind, Point } from './metrics';

// SGO city names -> Waymo per-city exposure regions. The mapping is explicit (no fuzzy matching): a crash city
// belongs to a region only when its (state, city) pair is listed here. Everything else is "unmatched" and is
// shown as counts only, never given a rate.

export type CityRegion = { region: string; label: string; state: string; cities: string[] };

export const CITY_REGIONS: CityRegion[] = [
  {
    region: 'city:phoenix', label: 'Phoenix metro', state: 'AZ',
    cities: ['Phoenix', 'Tempe', 'Chandler', 'Mesa', 'Scottsdale', 'Paradise Valley', 'Gilbert', 'Glendale'],
  },
  {
    region: 'city:los_angeles', label: 'Los Angeles area', state: 'CA',
    cities: ['Los Angeles', 'Beverly Hills', 'Culver City', 'Inglewood', 'Santa Monica', 'Venice', 'West Hollywood', 'Hollywood'],
  },
  { region: 'city:san_francisco', label: 'San Francisco', state: 'CA', cities: ['San Francisco'] },
  {
    // Overlaps city:san_francisco on purpose: Waymo reports SF city miles through 2025-09 and the wider Bay Area from 2026-01.
    // The two regions are never added together.
    region: 'city:sf_bay_area', label: 'San Francisco Bay Area', state: 'CA',
    cities: [
      'San Francisco', 'Daly City', 'Mountain View', 'Palo Alto', 'Redwood City', 'San Mateo', 'South San Francisco',
      'Sunnyvale', 'San Jose', 'Oakland', 'Santa Clara', 'Menlo Park', 'Brisbane', 'Millbrae', 'San Bruno', 'Burlingame', 'Berkeley',
    ],
  },
  { region: 'city:austin', label: 'Austin', state: 'TX', cities: ['Austin'] },
  { region: 'city:atlanta', label: 'Atlanta', state: 'GA', cities: ['Atlanta'] },
];
export const CITY_REGION_BY_KEY: Record<string, CityRegion> = Object.fromEntries(CITY_REGIONS.map((r) => [r.region, r]));

/** Spelling variants seen in the SGO that are unambiguous (lower-case key). */
export const CITY_ALIASES: Record<string, string> = {
  'san frabcisco': 'San Francisco',
  'marina del rey': 'Marina del Rey',
};

export const normCity = (city: string | null | undefined): string => {
  const k = (city ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return (CITY_ALIASES[k] ?? k).toLowerCase();
};
export const normState = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

/** Exposure regions (possibly several, e.g. San Francisco is in both SF and the Bay Area) that a crash city belongs to. */
export function regionsOfCity(city: string | null | undefined, state: string | null | undefined): string[] {
  const c = normCity(city);
  const s = normState(state);
  if (!c || !s) return [];
  return CITY_REGIONS.filter((r) => r.state === s && r.cities.some((x) => x.toLowerCase() === c)).map((r) => r.region);
}

export type CityCount = { key: string; city: string; state: string; n: number; regions: string[] };

/** "Where are the crashes": unique crashes per (state, city) for one program, sorted by count. */
export function rankCities(crashes: Crash[], program: string | null): CityCount[] {
  const m = new Map<string, { n: number; spell: Map<string, number>; state: string }>();
  for (const c of crashes) {
    if (program && c.program !== program) continue;
    const city = (c.city ?? '').trim();
    const state = normState(c.state);
    const key = state + '|' + normCity(city);
    const e = m.get(key) ?? { n: 0, spell: new Map(), state };
    e.n++;
    e.spell.set(city, (e.spell.get(city) ?? 0) + 1);
    m.set(key, e);
  }
  return [...m.entries()]
    .map(([key, e]) => {
      const city = [...e.spell.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const display = CITY_ALIASES[city.trim().toLowerCase()] ?? city;
      return { key, city: display || 'Not reported', state: e.state || 'n/a', n: e.n, regions: regionsOfCity(city, e.state) };
    })
    .sort((a, b) => b.n - a.n || a.city.localeCompare(b.city));
}

export const unmatchedCities = (rows: CityCount[]) => rows.filter((r) => r.regions.length === 0);

const KIND_RANK: Record<Kind, number> = { reported: 0, derived: 1, estimate: 2 };

export type Pooled = {
  k: number;
  kAdj: number;
  exposure: number;
  rate: number;
  lo: number;
  hi: number;
  lowSample: boolean;
  kind: Kind;
  months: number;
  partial: boolean;
  scenario: boolean;
  sourceIds: string[];
};

/** Pool several periods of one region (counts and miles summed over the periods that have exposure). Null when none do. */
export function pool(points: Point[], factor = 1e6): Pooled | null {
  const ok = points.filter((p) => p.exposure != null && p.exposure > 0);
  if (ok.length === 0) return null;
  const E = ok.reduce((a, p) => a + (p.exposure as number), 0);
  const k = ok.reduce((a, p) => a + p.k, 0);
  const kAdj = ok.reduce((a, p) => a + p.kAdj, 0);
  const [lo0, hi0] = ci95(k);
  const s = k > 0 ? kAdj / k : 1;
  const kind = ok.reduce<Kind>((a, p) => (p.exposureKind && KIND_RANK[p.exposureKind] > KIND_RANK[a] ? p.exposureKind : a), 'reported');
  const months = ok.reduce((a, p) => a + p.months.length, 0);
  return {
    k, kAdj, exposure: E,
    rate: (kAdj / E) * factor, lo: ((lo0 * s) / E) * factor, hi: ((hi0 * s) / E) * factor,
    lowSample: k < 10 || kind === 'estimate' || ok.some((p) => p.lowSample),
    kind, months,
    partial: ok.some((p) => p.partial) || ok.length !== points.length,
    scenario: ok.some((p) => p.scenario),
    sourceIds: [...new Set(ok.flatMap((p) => p.sourceIds))],
  };
}
