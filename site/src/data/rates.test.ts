import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { excludedByMonth, regionRateBlock, scopedCounts, sumExcluded, type CountRow } from './rates';
import { CITY_REGION_BY_KEY } from '../lib/cities';
import { operatorClass } from '../lib/scope';
import type { Crash } from '../data';
import type { ExposureRow } from '../lib/metrics';

const json = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const crash = (o: Partial<Crash>): Crash =>
  ({ program: 'waymo_ads', city: 'Phoenix', state: 'AZ', month: '2025-03', n_reports: 1, severity: 'none', tags: [], operator: 'none', entities: ['Waymo LLC'], entity: 'Waymo LLC', incident_key: Math.random().toString(36), ...o }) as Crash;

describe('operator classes (golden Driver / Operator Type vocabulary)', () => {
  it('only none and remote mean no in-vehicle operator', () => {
    expect(operatorClass('none')).toBe('driverless');
    expect(operatorClass('remote')).toBe('driverless');
    expect(operatorClass('in_vehicle')).toBe('in_vehicle');
    expect(operatorClass('in_vehicle_and_remote')).toBe('in_vehicle');
    for (const o of ['consumer', 'other', 'unknown', null, undefined]) expect(operatorClass(o as string)).toBe('other');
  });
});

describe('rider-only numerator', () => {
  const crashes = [
    crash({ operator: 'none' }), crash({ operator: 'remote' }), crash({ operator: 'in_vehicle' }),
    crash({ operator: 'in_vehicle_and_remote' }), crash({ operator: 'other' }),
  ];
  const rows: CountRow[] = [{ program: 'waymo_ads', company: 'waymo', month: '2025-03', file: 'ADS', crashes: 5, reports: 5, fatal: 0, serious_plus: 0, injury: 0, vru: 0 }];
  it('is on by default for rider-only programs: only none/remote crashes are counted', () => {
    expect(scopedCounts(rows, crashes, 'waymo_ads', 'us')!['2025-03'].crashes).toBe(2);
    expect(scopedCounts(rows, crashes, 'waymo_ads', 'us', { riderOnly: true })!['2025-03'].crashes).toBe(2);
  });
  it('can be switched off, which restores every crash the program filed', () => {
    expect(scopedCounts(rows, crashes, 'waymo_ads', 'us', { riderOnly: false })!['2025-03'].crashes).toBe(5);
  });
  it('never filters programs whose miles are not rider-only', () => {
    const l2 = [crash({ program: 'tesla_l2', operator: 'consumer' }), crash({ program: 'tesla_l2', operator: 'unknown' })];
    const l2rows: CountRow[] = [{ ...rows[0], program: 'tesla_l2', crashes: 2, reports: 2 }];
    expect(scopedCounts(l2rows, l2, 'tesla_l2', 'us')!['2025-03'].crashes).toBe(2);
  });
  it('reports the excluded crashes by reason, per month', () => {
    const ex = excludedByMonth(crashes, 'waymo_ads', 'us');
    expect(ex['2025-03']).toEqual({ in_vehicle: 2, other: 1 });
    expect(sumExcluded(ex, ['2025-03', '2025-03', '2025-04'])).toEqual({ in_vehicle: 2, other: 1 });
    expect(excludedByMonth(crashes, 'tesla_l2', 'us')).toEqual({});
  });
  it('applies together with the region scope', () => {
    const mixed = [crash({ city: 'Phoenix', operator: 'none' }), crash({ city: 'Phoenix', operator: 'in_vehicle' }), crash({ city: 'Tempe', operator: 'none' }), crash({ city: 'Miami', state: 'FL', operator: 'none' })];
    expect(scopedCounts([], mixed, 'waymo_ads', 'city:phoenix')!['2025-03'].crashes).toBe(2);
  });
});

describe('regions without a crash scope', () => {
  it('an unmapped region returns null counts (never an empty object that reads as zero)', () => {
    expect(scopedCounts([], [crash({})], 'waymo_ads', 'city:miami')).toBeNull();
    expect(regionRateBlock('city:miami')).toBe('unmapped');
  });
  it('ca and global are blocked from rates', () => {
    expect(regionRateBlock('ca')).toBe('miles-only');
    expect(regionRateBlock('global')).toBe('global');
    expect(regionRateBlock('us')).toBeNull();
    expect(regionRateBlock('city:phoenix')).toBeNull();
  });
  it('every non-national exposure region in exposure.json is a mapped city or a known blocked region', () => {
    const regions = new Set<string>(json('exposure.json').rows.map((r: ExposureRow) => r.region));
    for (const r of regions) {
      const block = regionRateBlock(r);
      if (r.startsWith('city:')) expect(CITY_REGION_BY_KEY[r], r).toBeTruthy();
      expect(['us', 'north_america'].includes(r) || block != null || CITY_REGION_BY_KEY[r] != null, r).toBe(true);
    }
  });
});

describe('entities', () => {
  it('count by membership, once per incident', () => {
    const k = 'K1';
    const crashes = [
      crash({ program: 'other_l2', entities: ['Ford', 'GM LLC'], entity: 'Ford', incident_key: k }),
      crash({ program: 'other_ads', entities: ['Ford'], entity: 'Ford', incident_key: k }), // same incident under another program
      crash({ program: 'other_l2', entities: ['GM LLC'], entity: 'GM LLC', incident_key: 'K2' }),
    ];
    expect(scopedCounts([], crashes, 'entity:Ford', 'us')!['2025-03'].crashes).toBe(1);
    expect(scopedCounts([], crashes, 'entity:GM LLC', 'us')!['2025-03'].crashes).toBe(2);
  });
});

// The published files must agree: per-program totals in records.json are the totals in counts.json, per month and measure.
describe('records.json agrees with counts.json (real data)', () => {
  const rec = json('records.json') as { fields: string[]; rows: unknown[][] };
  const crashes = rec.rows.map((row) => Object.fromEntries(rec.fields.map((f, i) => [f, row[i]]))) as unknown as Crash[];
  const counts = json('counts.json') as { rows: CountRow[] };
  const programs = [...new Set(counts.rows.map((r) => r.program))];
  it('per program, month and measure the program-level records equal the counts', () => {
    for (const program of programs) {
      const fromRows = scopedCounts(counts.rows, crashes, program, 'us', { riderOnly: false })!;
      const fromRecords: Record<string, Record<string, number>> = {};
      for (const c of crashes) {
        if (c.program !== program || !c.month) continue;
        const m = (fromRecords[c.month] ??= { crashes: 0, fatal: 0, serious_plus: 0, injury: 0, vru: 0 });
        m.crashes++;
        m.fatal += c.severity === 'fatal' ? 1 : 0;
        m.serious_plus += c.severity === 'serious' || c.severity === 'fatal' ? 1 : 0;
        m.injury += ['minor', 'moderate', 'serious', 'fatal'].includes(c.severity) ? 1 : 0;
        m.vru += c.tags.some((t) => t.startsWith('vru:')) ? 1 : 0;
      }
      for (const [month, want] of Object.entries(fromRows)) {
        if (month === 'null') continue; // undated reports have no month to compare
        for (const k of ['crashes', 'fatal', 'serious_plus', 'injury', 'vru'] as const) {
          expect(fromRecords[month]?.[k] ?? 0, `${program} ${month} ${k}`).toBe(want[k]);
        }
      }
    }
  });
  it('the rider-only filter on the real data only ever removes crashes', () => {
    const on = scopedCounts(counts.rows, crashes, 'waymo_ads', 'us', { riderOnly: true })!;
    const off = scopedCounts(counts.rows, crashes, 'waymo_ads', 'us', { riderOnly: false })!;
    let removed = 0;
    for (const [m, v] of Object.entries(off)) {
      expect(on[m]?.crashes ?? 0).toBeLessThanOrEqual(v.crashes);
      removed += v.crashes - (on[m]?.crashes ?? 0);
    }
    expect(removed).toBeGreaterThan(0);
    const ex = excludedByMonth(crashes, 'waymo_ads', 'us');
    expect(sumExcluded(ex, Object.keys(off))).toEqual(expect.objectContaining({}));
    const total = sumExcluded(ex, Object.keys(off));
    expect(total.in_vehicle + total.other).toBe(removed);
  });
  it('every program-level record has an operator and entities, and a multi-program incident appears once per program', () => {
    const byKey = new Map<string, Set<string>>();
    for (const c of crashes) {
      expect(c.entities.length).toBeGreaterThan(0);
      expect('operator' in c).toBe(true);
      (byKey.get(c.incident_key) ?? byKey.set(c.incident_key, new Set()).get(c.incident_key)!).add(c.program);
    }
    for (const c of crashes) expect(byKey.get(c.incident_key)!.size).toBe(c.n_programs_in_incident);
  });
});
