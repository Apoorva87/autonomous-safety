import { describe, expect, it } from 'vitest';
import { ci95 } from './poisson';
import { series, lagFactor, methodFlag, monthIncomplete, type CountsByMonth, type ExposureRow } from './metrics';
import { DEFAULT_SCENARIO, type Scenario } from '../state/scenario';

const mc = (n: number) => ({ crashes: n, robust_crashes: Math.floor(n / 2), reports: n + 1, fatal: 0, serious_plus: 0, injury: 0, vru: 0 });
const months = (y: number, n: number) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${y}-${String(i + 1).padStart(2, '0')}`, mc(n)]));
const row = (p: Partial<ExposureRow>): ExposureRow => ({
  program: 'waymo_ads', period: '2024', region: 'us', metric: 'miles', value: 1_000_000, kind: 'derived', source_ids: ['s1'], method: 'm', ...p,
});
const base = { program: 'waymo_ads', region: 'us', grain: 'year' as const, lastMonth: '2026-10', firstYear: 2024 };
const find = (pts: ReturnType<typeof series>, period: string) => pts.find((p) => p.period === period)!;

describe('series', () => {
  const counts: CountsByMonth = { ...months(2024, 10), ...months(2025, 1) };
  it('per1k = crashes / miles x 1000 and perM = x 1e6', () => {
    const exp = [row({ period: '2024', value: 2_000_000 })];
    const a = find(series(counts, exp, DEFAULT_SCENARIO, { ...base, metric: 'per1k' }), '2024');
    expect(a.k).toBe(120);
    expect(a.rate).toBeCloseTo((120 / 2_000_000) * 1000, 12);
    const b = find(series(counts, exp, DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024');
    expect(b.rate).toBeCloseTo(60, 9);
    const [lo, hi] = ci95(120);
    expect(b.lo).toBeCloseTo((lo / 2_000_000) * 1e6, 9);
    expect(b.hi).toBeCloseTo((hi / 2_000_000) * 1e6, 9);
  });
  it('milesPerCrash = miles / crashes', () => {
    const p = find(series(counts, [row({ value: 2_400_000 })], DEFAULT_SCENARIO, { ...base, metric: 'milesPerCrash' }), '2024');
    expect(p.rate).toBeCloseTo(20_000, 6);
    expect(p.lo!).toBeLessThan(20_000);
    expect(p.hi!).toBeGreaterThan(20_000);
  });
  it('exposure null gives a null rate with a reason, never 0 or Infinity', () => {
    const p = find(series(counts, [], DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024');
    expect(p.rate).toBeNull();
    expect(p.exposure).toBeNull();
    expect(p.reason).toBeTruthy();
    const z = find(series(counts, [row({ value: 0 })], DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024');
    expect(z.rate).toBeNull();
  });
  it('zero crashes with miles: milesPerCrash is null with a lower bound at miles / 3.689', () => {
    const p = find(series({}, [row({ value: 3_689_000 })], DEFAULT_SCENARIO, { ...base, metric: 'milesPerCrash' }), '2024');
    expect(p.k).toBe(0);
    expect(p.rate).toBeNull();
    expect(p.lowerBound).toBe(true);
    expect(p.lo!).toBeCloseTo(3_689_000 / 3.689, -2);
    expect(p.reason).toMatch(/lower bound/i);
  });
  it('expected count < 10, or an estimate exposure, flags lowSample', () => {
    const few: CountsByMonth = { '2024-03': mc(4) };
    expect(find(series(few, [row({})], DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024').lowSample).toBe(true);
    expect(find(series(counts, [row({ kind: 'derived' })], DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024').lowSample).toBe(false);
    expect(find(series(counts, [row({ kind: 'estimate' })], DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024').lowSample).toBe(true);
  });
  it('a non-default window factor sets scenario and scales counts', () => {
    const s: Scenario = { ...DEFAULT_SCENARIO, windowFactor: 1.5 };
    const p = find(series(counts, [row({})], s, { ...base, metric: 'perM' }), '2024');
    expect(p.scenario).toBe(true);
    expect(p.kAdj).toBeCloseTo(180, 9);
    expect(find(series(counts, [row({})], DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024').scenario).toBe(false);
  });
  it('lag adjustment divides recent-month counts by the lag CDF at their age', () => {
    const lag = { months: [0, 1, 2, 3], pre: null, post: [0.5, 0.8, 1, 1] };
    expect(lagFactor(lag, '2026-10', '2026-10', 1)).toBeCloseTo(2, 9);
    expect(lagFactor(lag, '2026-09', '2026-10', 1)).toBeCloseTo(1 / 0.8, 9);
    expect(lagFactor(lag, '2026-07', '2026-10', 1)).toBeCloseTo(1, 9);
    const c: CountsByMonth = { '2026-09': mc(8), '2026-10': mc(5) };
    const exp = [row({ period: '2026-09', value: 1e6 }), row({ period: '2026-10', value: 1e6 })];
    const s: Scenario = { ...DEFAULT_SCENARIO, lagAdjust: true };
    const pts = series(c, exp, s, { ...base, grain: 'month', year: 2026, metric: 'count', lag });
    expect(find(pts, '2026-09').kAdj).toBeCloseTo(10, 9);
    expect(find(pts, '2026-10').kAdj).toBeCloseTo(10, 9);
    expect(find(pts, '2026-09').scenario).toBe(true);
    // off by default
    expect(find(series(c, exp, DEFAULT_SCENARIO, { ...base, grain: 'month', year: 2026, metric: 'count', lag }), '2026-09').kAdj).toBe(8);
  });
  it('partial years use only the months with exposure on both sides', () => {
    const exp = [row({ period: '2024-07', value: 1e6 }), row({ period: '2024-08', value: 1e6 })];
    const p = find(series(counts, exp, DEFAULT_SCENARIO, { ...base, metric: 'perM' }), '2024');
    expect(p.partial).toBe(true);
    expect(p.k).toBe(20);
    expect(p.rate).toBeCloseTo(10, 9);
  });
  it('global-region exposure is never a US denominator', () => {
    const p = find(series(counts, [row({ region: 'global' })], DEFAULT_SCENARIO, { ...base, region: 'global', metric: 'perM' }), '2024');
    expect(p.rate).toBeNull();
    expect(p.reason).toMatch(/no US denominator/);
  });
  it('years before SGO reporting say so', () => {
    const pts = series(counts, [], DEFAULT_SCENARIO, { ...base, firstYear: 2019, metric: 'perM' });
    expect(find(pts, '2019').reason).toMatch(/2021-07/);
  });
  it('Tesla L2 gets no per-mile series by default: miles are derived only after the user sets an assumption', () => {
    const veh = [row({ program: 'tesla_l2', metric: 'active_vehicles', period: '2025', value: 1000, kind: 'estimate' })];
    const c: CountsByMonth = months(2025, 5);
    const o = { ...base, program: 'tesla_l2', metric: 'perM' as const };
    const none = find(series(c, veh, DEFAULT_SCENARIO, o), '2025');
    expect(none.rate).toBeNull();
    expect(none.exposure).toBeNull();
    expect(none.reason).toMatch(/assumption/);
    const set: Scenario = { ...DEFAULT_SCENARIO, estimates: { tesla_l2: { milesPerVehicleYear: 12000 } } };
    const p = find(series(c, veh, set, o), '2025');
    expect(p.exposure).toBeCloseTo(1000 * 12000, 6);
    expect(p.scenario).toBe(true);
    expect(p.notes.join(' ')).toMatch(/assumed miles per vehicle/);
  });
});

describe('per-vehicle rates are per vehicle-YEAR', () => {
  const veh = (period: string, value: number) => row({ program: 'tesla_l2', metric: 'active_vehicles', period, value, kind: 'estimate' });
  const o = { ...base, program: 'tesla_l2', metric: 'per10kVeh' as const, lastMonth: '2026-10', firstYear: 2025 };
  it('a full year divides by vehicles x 1', () => {
    const p = find(series(months(2025, 5), [veh('2025', 1000)], DEFAULT_SCENARIO, o), '2025');
    expect(p.k).toBe(60);
    expect(p.exposure).toBeCloseTo(1000, 9);
    expect(p.exposureUnit).toBe('vehicle-years');
    expect(p.rate).toBeCloseTo((60 / 1000) * 1e4, 9);
  });
  it('a 10-month year divides by vehicles x 10/12 and is flagged partial, so it is not read as safer', () => {
    const c: CountsByMonth = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`2026-${String(i + 1).padStart(2, '0')}`, mc(5)]));
    const full = find(series(months(2025, 5), [veh('2025', 1000), veh('2026', 1000)], DEFAULT_SCENARIO, o), '2025');
    const part = find(series(c, [veh('2025', 1000), veh('2026', 1000)], DEFAULT_SCENARIO, o), '2026');
    expect(part.k).toBe(50);
    expect(part.exposure).toBeCloseTo((1000 * 10) / 12, 9);
    expect(part.rate).toBeCloseTo((50 / ((1000 * 10) / 12)) * 1e4, 9);
    expect(part.rate).toBeCloseTo(full.rate!, 9); // same crash intensity: 5 per month either way
    expect(part.partial).toBe(true);
    expect(part.notes.join(' ')).toMatch(/Partial period: 10 of 12 months/);
  });
  it('monthly grain annualizes one month: vehicles x 1/12', () => {
    const p = find(series({ '2025-03': mc(5) }, [veh('2025-03', 1200)], DEFAULT_SCENARIO, { ...o, grain: 'month', year: 2025 }), '2025-03');
    expect(p.exposure).toBeCloseTo(100, 9);
    expect(p.rate).toBeCloseTo((5 / 100) * 1e4, 9);
  });
  it('miles per vehicle is annualized over the months covered', () => {
    const miles = Array.from({ length: 10 }, (_, i) => row({ program: 'tesla_l2', period: `2026-${String(i + 1).padStart(2, '0')}`, value: 500_000 }));
    const c: CountsByMonth = {};
    const p = find(series(c, [...miles, veh('2026', 1000)], DEFAULT_SCENARIO, { ...o, metric: 'milesPerVehicle', lastMonth: '2026-10' }), '2026');
    // 2026 covers 10 months: 5,000,000 miles / 1000 vehicles = 5000 miles in 10 months = 6000 per year
    expect(p.rate).toBeCloseTo(6000, 6);
  });
});

describe('regions that can never give a rate', () => {
  const ca = (o: Partial<ExposureRow>) => row({ region: 'ca', period: '2024', value: 2_906_137, ...o });
  const counts: CountsByMonth = months(2024, 25);
  const all = ['perM', 'per1k', 'per10kVeh', 'milesPerCrash', 'milesPerVehicle'] as const;
  it('a ca region can never produce a rate point, whatever the metric or the exposure rows', () => {
    const exp = [ca({}), ca({ metric: 'active_vehicles', value: 100 })];
    for (const metric of all) {
      for (const grain of ['year', 'month'] as const) {
        const pts = series(counts, exp, DEFAULT_SCENARIO, { ...base, region: 'ca', metric, grain, year: 2024, lastMonth: '2024-12' });
        for (const p of pts) {
          expect(p.rate).toBeNull();
          expect(p.lo).toBeNull();
          expect(p.hi).toBeNull();
          expect(p.lowerBound).toBeFalsy();
        }
      }
    }
  });
  it('the ca miles stay visible as an informational volume with the reason', () => {
    const p = find(series(counts, [ca({})], DEFAULT_SCENARIO, { ...base, region: 'ca', metric: 'perM', lastMonth: '2024-12' }), '2024');
    expect(p.volume).toBe(2_906_137);
    expect(p.reason).toMatch(/No comparable denominator/);
    expect(p.reason).toMatch(/Dec.Nov/);
  });
  it('a region with no crash scope (null counts) gives no rate and a reason, never 0', () => {
    const exp = [row({ region: 'city:miami', period: '2024', value: 1_000_000 })];
    for (const metric of ['perM', 'milesPerCrash', 'count'] as const) {
      const p = find(series(null, exp, DEFAULT_SCENARIO, { ...base, region: 'city:miami', metric, lastMonth: '2024-12' }), '2024');
      expect(p.rate).toBeNull();
      expect(p.reason).toMatch(/region not mapped/);
    }
  });
  it('worldwide exposure is never a US denominator', () => {
    const p = find(series(counts, [row({ region: 'global' })], DEFAULT_SCENARIO, { ...base, region: 'global', metric: 'perM', lastMonth: '2024-12' }), '2024');
    expect(p.rate).toBeNull();
  });
});

describe('incomplete recent months', () => {
  const lag = { months: [0, 1, 2, 3], pre: null, post: [0.5, 0.8, 0.95, 1] };
  it('a month is incomplete while its lag CDF is below 90%', () => {
    expect(monthIncomplete(lag, '2026-10', '2026-10')).toBe(true); // 0.5
    expect(monthIncomplete(lag, '2026-09', '2026-10')).toBe(true); // 0.8
    expect(monthIncomplete(lag, '2026-08', '2026-10')).toBe(false); // 0.95
    expect(monthIncomplete(null, '2026-10', '2026-10')).toBe(true); // no curve: the last two months
    expect(monthIncomplete(null, '2026-07', '2026-10')).toBe(false);
  });
  it('each month uses the curve of its own regime, in whole months', () => {
    const both = { months: [0, 1, 2], pre: [0.2, 0.6, 1], post: [0.7, 0.95, 1] };
    expect(lagFactor(both, '2025-05', '2025-06', 1)).toBeCloseTo(1 / 0.6, 9); // pre curve, age 1
    expect(lagFactor(both, '2025-07', '2025-08', 1)).toBeCloseTo(1 / 0.95, 9); // post curve, age 1
    expect(monthIncomplete(both, '2025-07', '2025-08')).toBe(false);
    expect(monthIncomplete(both, '2025-05', '2025-06')).toBe(true);
  });
  it('the robust measure counts robust crashes', () => {
    const c: CountsByMonth = { '2026-09': mc(8) };
    const exp = [row({ period: '2026-09', value: 1e6 })];
    const pts = series(c, exp, DEFAULT_SCENARIO, { ...base, grain: 'month', year: 2026, metric: 'count', measure: 'robust' });
    expect(find(pts, '2026-09').k).toBe(4);
  });
  it('points list their incomplete months; the headline numbers are unchanged unless lag adjustment is on', () => {
    const c: CountsByMonth = { '2026-08': mc(10), '2026-09': mc(10), '2026-10': mc(10) };
    const exp = ['2026-08', '2026-09', '2026-10'].map((m) => row({ period: m, value: 1e6 }));
    const o = { ...base, grain: 'month' as const, year: 2026, metric: 'perM' as const, lag };
    const pts = series(c, exp, DEFAULT_SCENARIO, o);
    expect(find(pts, '2026-08').incomplete).toEqual([]);
    expect(find(pts, '2026-09').incomplete).toEqual(['2026-09']);
    expect(find(pts, '2026-10').incomplete).toEqual(['2026-10']);
    expect(find(pts, '2026-10').rate).toBeCloseTo(10, 9);
    const adj = series(c, exp, { ...DEFAULT_SCENARIO, lagAdjust: true }, o);
    expect(find(adj, '2026-10').rate).toBeCloseTo(20, 9);
    const yr = find(series(c, [row({ period: '2026', value: 3e6 })], DEFAULT_SCENARIO, { ...o, grain: 'year', firstYear: 2026 }), '2026');
    expect(yr.incomplete).toContain('2026-10');
  });
});

describe('exposure method flag (>3x adjacent segments)', () => {
  const note = 'Derived: cumulative miles at 2024-07-31 minus cumulative miles at 2024-06-30. Note: adjacent disclosure segments differ by >3\u00d7; disclosures are rounded milestones, so the monthly split is unreliable.';
  it('parses the note out of the method text and ignores ordinary methods', () => {
    expect(methodFlag(note)).toBe('Adjacent disclosure segments differ by >3\u00d7; disclosures are rounded milestones, so the monthly split is unreliable.');
    expect(methodFlag('Derived: cumulative miles at 2024-07-31 minus 2024-06-30 (difference of disclosures).')).toBeNull();
    expect(methodFlag(undefined)).toBeNull();
  });
  it('marks the monthly point whose exposure row carries the note, and a year containing it, but not other months', () => {
    const mc1 = { crashes: 5, robust_crashes: 2, reports: 5, fatal: 0, serious_plus: 0, injury: 0, vru: 0 };
    const counts: CountsByMonth = { '2024-06': mc1, '2024-07': mc1 };
    const exp = [row({ period: '2024-06', value: 1e5 }), row({ period: '2024-07', value: 1.4e4, method: note })];
    const m = series(counts, exp, DEFAULT_SCENARIO, { program: 'waymo_ads', region: 'us', metric: 'perM', grain: 'month', year: 2024, lastMonth: '2026-10' });
    expect(m.find((p) => p.period === '2024-07')!.flag).toMatch(/unreliable/);
    expect(m.find((p) => p.period === '2024-06')!.flag).toBeNull();
  });
});
