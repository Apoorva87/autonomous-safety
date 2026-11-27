import { describe, expect, it } from 'vitest';
import { learningCurve, monthlyPoints, quarterOf, straddlesBreak } from './learning';
import { ci95 } from './poisson';
import type { CountsByMonth, ExposureRow } from './metrics';
import { DEFAULT_SCENARIO } from '../state/scenario';

const mc = (n: number) => ({ crashes: n, reports: n, fatal: 0, serious_plus: 0, injury: 0, vru: 0 });
const row = (period: string, value: number, kind: ExposureRow['kind'] = 'estimate'): ExposureRow => ({
  program: 'waymo_ads', period, region: 'us', metric: 'miles', value, kind, source_ids: ['s1'], method: 'm',
});
const opts = { program: 'waymo_ads', region: 'us', lastMonth: '2026-06' };

describe('quarterOf', () => {
  it('maps months to calendar quarters', () => {
    expect(quarterOf('2025-01')).toBe('2025-Q1');
    expect(quarterOf('2025-06')).toBe('2025-Q2');
    expect(quarterOf('2025-12')).toBe('2025-Q4');
  });
});

describe('learning curve', () => {
  // 2024-07..2025-06 miles; crashes 2 per month.
  const months = ['2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
  const exp = months.map((m, i) => row(m, 1_000_000 * (i + 1)));
  const counts: CountsByMonth = Object.fromEntries(months.map((m) => [m, mc(2)]));
  const monthly = monthlyPoints(counts, exp, DEFAULT_SCENARIO, opts);

  it('builds quarters with cumulative miles from the first disclosed month', () => {
    const lc = learningCurve(monthly, { group: 'quarter', lastMonth: '2026-06' });
    expect(lc.map((p) => p.period)).toEqual(['2024-Q3', '2024-Q4', '2025-Q1', '2025-Q2']);
    expect(lc[0].miles).toBe(1e6 + 2e6 + 3e6);
    expect(lc[0].cumMiles).toBe(6e6);
    expect(lc[1].cumMiles).toBe(6e6 + (4 + 5 + 6) * 1e6);
    expect(lc[3].cumMiles).toBe(78e6); // 1+...+12 million
  });
  it('rate = crashes / miles x 1e6 with the exact Poisson interval; miles per crash is the inverse', () => {
    const q = learningCurve(monthly, { group: 'quarter', lastMonth: '2026-06' })[1];
    expect(q.k).toBe(6);
    expect(q.rate).toBeCloseTo((6 / 15e6) * 1e6, 9);
    const [lo, hi] = ci95(6);
    expect(q.lo).toBeCloseTo((lo / 15e6) * 1e6, 9);
    expect(q.hi).toBeCloseTo((hi / 15e6) * 1e6, 9);
    expect(q.mpc).toBeCloseTo(15e6 / 6, 6);
    expect(q.mpcLo).toBeCloseTo(15e6 / hi, 6);
    expect(q.lowSample).toBe(true); // k < 10 and estimate
  });
  it('a base offset (lifetime miles before the series) shifts x only', () => {
    const a = learningCurve(monthly, { group: 'quarter', lastMonth: '2026-06' });
    const b = learningCurve(monthly, { group: 'quarter', lastMonth: '2026-06', base: 50e6 });
    expect(b[0].cumMiles - a[0].cumMiles).toBe(50e6);
    expect(b[0].rate).toBe(a[0].rate);
  });
  it('drops quarters with a missing month but keeps the running miles', () => {
    const gap = exp.filter((r) => r.period !== '2024-11');
    const lc = learningCurve(monthlyPoints(counts, gap, DEFAULT_SCENARIO, opts), { group: 'quarter', lastMonth: '2026-06' });
    expect(lc.map((p) => p.period)).toEqual(['2024-Q3', '2025-Q1', '2025-Q2']);
    expect(lc[1].cumMiles).toBe(6e6 + (4 + 6) * 1e6 + (7 + 8 + 9) * 1e6);
  });
  it('zero crashes gives a null miles-per-crash with a lower bound, not Infinity', () => {
    const lc = learningCurve(monthlyPoints({}, exp, DEFAULT_SCENARIO, opts), { group: 'quarter', lastMonth: '2026-06' });
    expect(lc[0].k).toBe(0);
    expect(lc[0].mpc).toBeNull();
    expect(Number.isFinite(lc[0].mpcLo)).toBe(true);
    expect(lc[0].rate).toBe(0);
  });
  it('no miles rows gives no points', () => {
    expect(monthlyPoints(counts, [], DEFAULT_SCENARIO, opts)).toEqual([]);
  });
  it('flags recent quarters whose reports are still arriving', () => {
    const lag = { days: [0, 30, 60, 90], cdf: [0.4, 0.7, 0.95, 1] };
    const lc = learningCurve(monthly, { group: 'quarter', lastMonth: '2025-07', lag });
    expect(lc[lc.length - 1].recent).toBe(true);
    expect(lc[0].recent).toBe(false);
  });
  it('marks the period that straddles the 2025-06-16 rule change (Q2 by quarter, June by month), and only that one', () => {
    const q = learningCurve(monthly, { group: 'quarter', lastMonth: '2026-06' });
    expect(q.map((p) => [p.period, p.straddlesBreak])).toEqual([['2024-Q3', false], ['2024-Q4', false], ['2025-Q1', false], ['2025-Q2', true]]);
    const m = learningCurve(monthly, { group: 'month', lastMonth: '2026-06' });
    expect(m.filter((p) => p.straddlesBreak).map((p) => p.period)).toEqual(['2025-06']);
    expect(straddlesBreak(['2025-05'])).toBe(false);
    expect(straddlesBreak(['2025-07', '2025-08', '2025-09'])).toBe(false);
  });
  it('carries the unreliable-split flag instead of dropping it', () => {
    const note = 'Derived: x. Note: adjacent disclosure segments differ by >3\u00d7; disclosures are rounded milestones, so the monthly split is unreliable.';
    const flagged = exp.map((r) => (r.period === '2024-08' ? { ...r, method: note } : r));
    const q = learningCurve(monthlyPoints(counts, flagged, DEFAULT_SCENARIO, opts), { group: 'quarter', lastMonth: '2026-06' });
    expect(q[0].flag).toMatch(/unreliable/);
    expect(q[1].flag).toBeNull();
  });
});
