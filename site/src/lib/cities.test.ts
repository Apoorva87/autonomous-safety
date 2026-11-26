import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CITY_REGIONS, CITY_REGION_BY_KEY, normCity, pool, rankCities, regionsOfCity, unmatchedCities } from './cities';
import { ci95 } from './poisson';
import { series, type CountsByMonth, type ExposureRow } from './metrics';
import { scopeOf, scopedCounts, type CountRow } from '../data/rates';
import { DEFAULT_SCENARIO } from '../state/scenario';
import type { Crash } from '../data';

const data = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const crash = (o: Partial<Crash>): Crash => ({ program: 'waymo_ads', city: 'Phoenix', state: 'AZ', month: '2025-03', n_reports: 1, severity: 'none', tags: [], ...o }) as Crash;

describe('city name mapping', () => {
  it('maps SGO (state, city) pairs to exposure regions explicitly', () => {
    expect(regionsOfCity('Tempe', 'AZ')).toEqual(['city:phoenix']);
    expect(regionsOfCity('  los   angeles ', 'ca')).toEqual(['city:los_angeles']);
    expect(regionsOfCity('Austin', 'TX')).toEqual(['city:austin']);
  });
  it('San Francisco is in both the SF and the Bay Area region (never summed)', () => {
    expect(regionsOfCity('San Francisco', 'CA').sort()).toEqual(['city:san_francisco', 'city:sf_bay_area']);
    expect(regionsOfCity('San Jose', 'CA')).toEqual(['city:sf_bay_area']);
  });
  it('does not guess: wrong state, unlisted city and blanks are unmatched', () => {
    expect(regionsOfCity('Phoenix', 'CA')).toEqual([]);
    expect(regionsOfCity('Miami', 'FL')).toEqual([]);
    expect(regionsOfCity(null, 'AZ')).toEqual([]);
    expect(regionsOfCity('Austin', null)).toEqual([]);
  });
  it('known typos normalise to one key', () => {
    expect(normCity('San Frabcisco')).toBe('san francisco');
  });
  it('scopeOf (used by the Rates tab) agrees with the mapping', () => {
    for (const r of CITY_REGIONS) expect(scopeOf(r.region)).toEqual({ state: r.state, cities: r.cities });
    expect(scopeOf('city:nowhere')).toBeNull();
  });
  it('every per-city exposure region in exposure.json has a mapping', () => {
    const regions = new Set<string>(data('exposure.json').rows.map((r: ExposureRow) => r.region).filter((r: string) => r.startsWith('city:')));
    const missing = [...regions].filter((r) => !CITY_REGION_BY_KEY[r]);
    expect(missing).toEqual([]);
  });
  it('lists unmatched cities for a program (real data: Miami and Houston have crashes but no Waymo miles)', () => {
    const rec = data('records.json') as { fields: string[]; rows: unknown[][] };
    const crashes = rec.rows.map((row) => Object.fromEntries(rec.fields.map((f, i) => [f, row[i]]))) as unknown as Crash[];
    const ranked = rankCities(crashes, 'waymo_ads');
    const un = unmatchedCities(ranked);
    expect(un.find((u) => u.city === 'Miami')?.n).toBe(33);
    expect(un.find((u) => u.city === 'Houston')?.state).toBe('TX');
    expect(un.some((u) => u.city === 'Phoenix' && u.state === 'CA')).toBe(true); // a mis-keyed state is not silently merged
    const matched = ranked.filter((r) => r.regions.length > 0).reduce((a, r) => a + r.n, 0);
    expect(matched + un.reduce((a, r) => a + r.n, 0)).toBe(ranked.reduce((a, r) => a + r.n, 0));
  });
});

describe('per-city rate join', () => {
  const row = (p: Partial<ExposureRow>): ExposureRow => ({
    program: 'waymo_ads', period: '2025-03', region: 'city:phoenix', metric: 'miles', value: 1_000_000, kind: 'estimate', source_ids: ['s'], method: 'm', ...p,
  });
  it('counts only crashes in the region (right state and listed city), over the months that have miles', () => {
    const crashes = [
      crash({ city: 'Phoenix' }), crash({ city: 'Tempe' }), crash({ city: 'Tempe', month: '2025-04' }),
      crash({ city: 'Phoenix', state: 'CA' }), crash({ city: 'Los Angeles', state: 'CA' }), crash({ program: 'zoox_ads' }),
    ];
    const counts = scopedCounts([] as CountRow[], crashes, 'waymo_ads', 'city:phoenix');
    expect(counts['2025-03'].crashes).toBe(2);
    expect(counts['2025-04'].crashes).toBe(1);
    const pts = series(counts, [row({}), row({ period: '2025-04', value: 500_000 })], DEFAULT_SCENARIO, {
      program: 'waymo_ads', region: 'city:phoenix', metric: 'perM', grain: 'month', year: 2025, lastMonth: '2025-12',
    });
    const p = pool(pts)!;
    expect(p.k).toBe(3);
    expect(p.exposure).toBe(1_500_000);
    expect(p.rate).toBeCloseTo((3 / 1_500_000) * 1e6, 9);
    const [lo, hi] = ci95(3);
    expect(p.lo).toBeCloseTo((lo / 1_500_000) * 1e6, 9);
    expect(p.hi).toBeCloseTo((hi / 1_500_000) * 1e6, 9);
    expect(p.lowSample).toBe(true); // 3 crashes and estimated miles
    expect(p.kind).toBe('estimate');
  });
  it('pool returns null (no 0 or Infinity) when no period has miles', () => {
    const counts: CountsByMonth = {};
    const pts = series(counts, [], DEFAULT_SCENARIO, {
      program: 'waymo_ads', region: 'city:phoenix', metric: 'perM', grain: 'month', year: 2025, lastMonth: '2025-12',
    });
    expect(pool(pts)).toBeNull();
  });
});
