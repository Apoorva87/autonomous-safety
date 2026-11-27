import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Crash } from '../data';
import type { ExposureRow, Point } from './metrics';
import { NUMERATOR_BY_ID, countedCrashes, forestRows, quarterSeries, regimeOf, usableMonths, type MonthExposure } from './improve';

const json = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const crash = (o: Partial<Crash>): Crash =>
  ({ program: 'waymo_ads', month: '2025-03', severity: 'none', operator: 'none', robust: false, airbag: false, sv_movement: 'stopped', tags: [], ...o }) as Crash;

describe('regimes', () => {
  it('June 2025 is mixed and belongs to neither regime', () => {
    expect(regimeOf('2025-05')).toBe('pre');
    expect(regimeOf('2025-06')).toBeNull();
    expect(regimeOf('2025-07')).toBe('post');
  });
  it('usable months drop the mixed month, incomplete months and points without a rate', () => {
    const pt = (period: string, o: Partial<Point> = {}) => ({ period, exposure: 1e6, rate: 1, assumption: false, exposureKind: 'estimate', ...o }) as Point;
    const lag = { months: [0, 1, 2], pre: [0.5, 0.95, 1], post: [0.5, 0.95, 1] };
    const ms = usableMonths([pt('2025-05'), pt('2025-06'), pt('2025-07'), pt('2025-08'), pt('2025-09', { rate: null })], lag, '2025-08');
    expect(ms.map((m) => m.month)).toEqual(['2025-05', '2025-07']); // 2025-08 is still filling in
    expect(ms[0].estimate).toBe(true);
  });
});

describe('forest rows', () => {
  const months: MonthExposure[] = ['2025-01', '2025-02', '2025-07', '2025-08'].map((month) => ({ month, exposure: 1e6, estimate: false }));
  const cs = [
    ...Array.from({ length: 20 }, () => crash({ month: '2025-01', robust: true })),
    ...Array.from({ length: 40 }, () => crash({ month: '2025-02' })),
    ...Array.from({ length: 22 }, () => crash({ month: '2025-07', robust: true })),
    ...Array.from({ length: 5 }, () => crash({ month: '2025-08' })),
    crash({ month: '2025-06', robust: true }), // mixed month: never counted
  ];
  const rows = forestRows(cs, months, 1e6);
  const by = Object.fromEntries(rows.map((r) => [r.numerator.id, r]));
  it('counts each numerator over the usable months of each regime', () => {
    expect([by.robust.pre.k, by.robust.post.k]).toEqual([20, 22]);
    expect([by.all.pre.k, by.all.post.k]).toEqual([60, 27]);
    expect(by.robust.pre.rate).toBeCloseTo(10, 9);
    expect(by.robust.rr.rr).toBeCloseTo(1.1, 9);
  });
  it('the robust verdict is no detectable change; the all-crash drop is attributed to the reporting change', () => {
    expect(by.robust.verdict.code).toBe('no_change');
    expect(by.all.verdict.code).toBe('lower');
    expect(by.all.verdict.text).toMatch(/reporting change/);
  });
  it('rider-only programs count only driverless crashes', () => {
    const mixed = [crash({ operator: 'none' }), crash({ operator: 'in_vehicle' }), crash({ program: 'tesla_l2', operator: 'consumer' })];
    expect(countedCrashes(mixed, 'waymo_ads').length).toBe(1);
    expect(countedCrashes(mixed, 'waymo_ads', false).length).toBe(2);
    expect(countedCrashes(mixed, 'tesla_l2').length).toBe(1);
  });
});

describe('quarter series', () => {
  it('never spans the break and labels a partial quarter', () => {
    const months: MonthExposure[] = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-07', '2025-08', '2025-09'].map((month) => ({ month, exposure: 1e6, estimate: true }));
    const q = quarterSeries([crash({ month: '2025-04', robust: true })], months, NUMERATOR_BY_ID.robust.test, 1e6);
    expect(q.map((p) => [p.label, p.regime])).toEqual([['2025-Q1', 'pre'], ['2025-Q2 (Apr–May)', 'pre'], ['2025-Q3', 'post']]);
    expect(q[1].k).toBe(1);
    expect(q[1].rate).toBeCloseTo(0.5, 9);
  });
});

// Re-derivation (i): Waymo, US rider-only miles, threshold-robust numerator, pre vs post.
describe('Waymo before/after on the published data', () => {
  const rec = json('records.json') as { fields: string[]; rows: unknown[][] };
  const crashes = rec.rows.map((row) => Object.fromEntries(rec.fields.map((f, i) => [f, row[i]]))) as unknown as Crash[];
  const exposure = (json('exposure.json') as { rows: ExposureRow[] }).rows;
  const months: MonthExposure[] = exposure
    .filter((r) => r.program === 'waymo_ads' && r.region === 'us' && r.metric === 'miles' && r.period.length === 7 && regimeOf(r.period))
    .map((r) => ({ month: r.period, exposure: r.value, estimate: r.kind === 'estimate' }));
  it('robust rate ratio is about 1 (no detectable change); all-crash ratio is about 0.55', () => {
    const rows = forestRows(countedCrashes(crashes, 'waymo_ads'), months, 1e6);
    const robust = rows.find((r) => r.numerator.id === 'robust')!;
    const all = rows.find((r) => r.numerator.id === 'all')!;
    expect(robust.pre.e).toBe(86939177); // 2023-02..2025-05 since the 2023 Waymo disclosures were added
    expect(robust.post.e).toBe(175363998);
    expect(robust.rr.lo!).toBeLessThan(1);
    expect(robust.rr.hi!).toBeGreaterThan(1);
    expect(robust.rr.rr!).toBeGreaterThan(0.9);
    expect(robust.rr.rr!).toBeLessThan(1.15);
    expect(robust.verdict.code).toBe('no_change');
    expect(all.rr.hi!).toBeLessThan(0.65);
  });
});
