import { describe, expect, it } from 'vitest';
import { ci95 } from './poisson';
import { series, lagFactor, type CountsByMonth, type ExposureRow } from './metrics';
import { DEFAULT_SCENARIO, type Scenario } from '../state/scenario';

const mc = (n: number) => ({ crashes: n, reports: n + 1, fatal: 0, serious_plus: 0, injury: 0, vru: 0 });
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
    const lag = { days: [0, 30, 60, 90], cdf: [0.5, 0.8, 1, 1] };
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
  it('Tesla L2 derives miles from vehicles x assumed miles per vehicle and flags scenario', () => {
    const veh = [row({ program: 'tesla_l2', metric: 'active_vehicles', period: '2025', value: 1000, kind: 'estimate' })];
    const c: CountsByMonth = months(2025, 5);
    const o = { ...base, program: 'tesla_l2', metric: 'perM' as const };
    const p = find(series(c, veh, DEFAULT_SCENARIO, o), '2025');
    expect(p.exposure).toBeCloseTo(1000 * 12000, 6);
    expect(p.scenario).toBe(true);
    const v = find(series(c, veh, DEFAULT_SCENARIO, { ...o, metric: 'per10kVeh' }), '2025');
    expect(v.rate).toBeCloseTo((60 / 1000) * 1e4, 9);
    expect(v.scenario).toBe(false);
  });
});
