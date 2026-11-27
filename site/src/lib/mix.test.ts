import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Crash } from '../data';
import { DIM_BY_ID, artifactsFor, mixSeries, shiftTest, type MixPoint } from './mix';

const json = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const crash = (o: Partial<Crash>): Crash =>
  ({ program: 'waymo_ads', month: '2024-03', roadway_type: 'street', tags: [], sv_movement: 'stopped', crash_with: 'suv', sv_contact_areas: ['rear'], light_from_time: 'day', speed_band: '0', ...o }) as Crash;

describe('mixSeries', () => {
  const cs = [
    ...Array.from({ length: 30 }, () => crash({ roadway_type: 'intersection' })),
    ...Array.from({ length: 10 }, () => crash({ roadway_type: 'street' })),
    ...Array.from({ length: 10 }, () => crash({ roadway_type: 'unknown' })),
    crash({ roadway_type: 'traffic_circle' }), // under 3%: folded
  ];
  it('shares among known exclude unknowns; including unknown keeps them in the denominator', () => {
    const known = mixSeries(cs, DIM_BY_ID.road, { knownOnly: true });
    const all = mixSeries(cs, DIM_BY_ID.road, { knownOnly: false });
    const k = known.categories.find((c) => c.category === 'Intersection')!.points[0];
    const a = all.categories.find((c) => c.category === 'Intersection')!.points[0];
    expect([k.k, k.n]).toEqual([30, 41]);
    expect([a.k, a.n]).toEqual([30, 51]);
    expect(known.unknown[0].share).toBeCloseTo(10 / 51, 9);
    expect(known.categories.map((c) => c.category)).toContain('Other (small categories)');
    expect(k.lo!).toBeLessThan(k.share!);
  });
  it('half-years with too few crashes carry no share', () => {
    const r = mixSeries(cs.slice(0, 5), DIM_BY_ID.road, { knownOnly: true });
    expect(r.categories[0].points[0].share).toBeNull();
  });
});

describe('shiftTest', () => {
  const pts = (pre: [number, number][], post: [number, number][]): MixPoint[] => [
    ...pre.map(([k, n], i) => ({ period: `202${1 + Math.floor(i / 2)}H${(i % 2) + 1}`, k, n, share: k / n, lo: null, hi: null })),
    ...post.map(([k, n], i) => ({ period: `202${5 + Math.floor((i + 1) / 2)}H${((i + 1) % 2) + 1}`, k, n, share: k / n, lo: null, hi: null })),
  ];
  it('a pure step at the rule change is step-only; a step with a same-sign trend inside a regime survives', () => {
    expect(shiftTest(pts([[50, 100], [50, 100], [50, 100], [50, 100]], [[20, 100], [20, 100]]))!.verdict).toBe('step-only');
    expect(shiftTest(pts([[80, 100], [65, 100], [50, 100], [40, 100]], [[20, 100], [20, 100]]))!.verdict).toBe('survives');
    expect(shiftTest(pts([[50, 100], [50, 100]], [[48, 100], [52, 100]]))!.verdict).toBe('none');
  });
});

describe('real data', () => {
  const rec = json('records.json') as { fields: string[]; rows: unknown[][] };
  const crashes = rec.rows.map((row) => Object.fromEntries(rec.fields.map((f, i) => [f, row[i]]))) as unknown as Crash[];
  it('Waymo intersection share falls from 2021-22 to 2026 (review: 67-76% to 12-16%)', () => {
    const r = mixSeries(crashes.filter((c) => c.program === 'waymo_ads'), DIM_BY_ID.road, { knownOnly: true });
    const s = r.categories.find((c) => c.category === 'Intersection')!;
    const early = s.points.find((p) => p.period === '2022H1')!;
    const late = s.points.find((p) => p.period === '2026H1')!;
    expect(early.share!).toBeGreaterThan(0.5);
    expect(late.share!).toBeLessThan(0.3);
  });
  it('Tesla highway share among known road types is lower from 2024 than in 2022-23', () => {
    const r = mixSeries(crashes.filter((c) => c.program === 'tesla_l2'), DIM_BY_ID.road, { knownOnly: true });
    const s = r.categories.find((c) => c.category === 'Highway or freeway')!;
    const v = (p: string) => s.points.find((x) => x.period === p)!.share!;
    expect(v('2022H2')).toBeGreaterThan(0.6);
    expect(v('2024H2')).toBeLessThan(0.62);
    expect(artifactsFor('tesla_l2', 'road').some((a) => a.id === 'tesla-unknown')).toBe(true);
  });
});
