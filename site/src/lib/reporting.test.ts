import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dumbbell, lateBySeverity, medianGap, revisionSeries, type RevisionsFile } from './reporting';
import { hourStats, isNightClock } from './timeOfDay';
import type { Crash } from '../data';

const json = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));

describe('revisions (real data, re-derivation ii)', () => {
  const file = json('revisions.json') as RevisionsFile;
  it('every current report is counted once', () => {
    expect(file.rows.reduce((a, r) => a + r.reports, 0)).toBe(file.total_reports);
  });
  it('Tesla L2: nearly every 2021-22 report was revised, almost none from 2026', () => {
    const y = Object.fromEntries(revisionSeries(file.rows, 'tesla_l2', 'year').map((p) => [p.period, p]));
    expect(y['2022'].revised![0]).toBeGreaterThan(0.95);
    expect(y['2026'].revised![0]).toBeLessThan(0.03);
    expect(y['2024'].allUnknown![0]).toBeGreaterThan(0.2);
    expect(y['2022'].allUnknown![0]).toBeLessThan(0.1);
  });
  it('Tesla L2 first versions leave the movement unknown far more often than the latest versions', () => {
    const d = dumbbell(file, 'tesla_l2').find((x) => x.field === 'sv_movement')!;
    expect(d.first).toBeGreaterThan(0.8);
    expect(d.latest).toBeLessThan(0.3);
    expect(medianGap(file.rows, 'tesla_l2')).not.toBeNull();
  });
});

describe('late filing by severity (real data)', () => {
  const lag = json('lag.json') as { programs: Record<string, { hist: Record<string, Record<string, number[]>> }> };
  it('serious and fatal crashes are filed more than a month late far more often than no-injury crashes', () => {
    const rows = lateBySeverity(Object.values(lag.programs).map((p) => p.hist), 'pre');
    const share = (s: string) => rows.find((r) => r.severity === s)!.late![0];
    expect(share('serious')).toBeGreaterThan(share('none') * 3);
  });
});

describe('time of day', () => {
  const c = (hour: number | null, month = '2024-05', o: Partial<Crash> = {}) => ({ hour, month, light_from_time: 'day', time_basis: 'filed', ...o }) as Crash;
  it('night is 21:00 to 05:59', () => {
    expect([20, 21, 0, 5, 6].map(isNightClock)).toEqual([false, true, true, true, false]);
  });
  it('counts by hour, night share with an interval, and regimes', () => {
    const s = hourStats([c(22), c(2), c(12), c(13, '2025-08'), c(null)], 'pre');
    expect(s.n).toBe(3);
    expect(s.nightK).toBe(2);
    expect(s.hours[22]).toBe(1);
    expect(s.night![0]).toBeCloseTo(2 / 3, 9);
    expect(hourStats([c(13, '2025-08'), c(14, '2025-06')], 'post').n).toBe(1); // June 2025 is in neither regime
  });
  it('re-derivation (iii): Tesla L2 night share is close to Waymo once Tesla UTC times are converted', () => {
    const rec = json('records.json') as { fields: string[]; rows: unknown[][] };
    const crashes = rec.rows.map((row) => Object.fromEntries(rec.fields.map((f, i) => [f, row[i]]))) as unknown as Crash[];
    const t = hourStats(crashes.filter((x) => x.program === 'tesla_l2'), 'all');
    const w = hourStats(crashes.filter((x) => x.program === 'waymo_ads'), 'all');
    expect(t.converted).toBe(t.n);
    expect(t.night![0]).toBeGreaterThan(0.22);
    expect(t.night![0]).toBeLessThan(0.32);
    expect(w.night![0]).toBeGreaterThan(0.26);
    expect(w.night![0]).toBeLessThan(0.32);
  });
});
