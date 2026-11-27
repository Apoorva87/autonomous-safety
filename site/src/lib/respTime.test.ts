import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRows, type RespFile, type RespRow } from './responsibility';
import { byHalfYear, crashLabels, halfOf, ownKindCounts, type CrashLabel } from './respTime';

const json = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const row = (o: Partial<RespRow> & Record<string, unknown>): RespRow =>
  ({ report_id: 'R', incident_key: 'I', program: 'waymo_ads', month: '2025-01', label: 'other_party', confidence: 'high', rule: 'RESP-OTH-1', severity: 'none', ...o }) as RespRow;

describe('crash-level labels', () => {
  it('one crash per program and incident, with the roll-up label', () => {
    const rows = [
      row({ report_id: 'A', incident_key: 'K', program: 'gm_cruise_ads', crash_rep: true, crash_label: 'other_party', label: 'indeterminate', confidence: 'low' }),
      row({ report_id: 'B', incident_key: 'K', program: 'gm_cruise_ads', crash_rep: false, crash_label: 'other_party', label: 'other_party', confidence: 'medium' }),
      row({ report_id: 'C', incident_key: 'L', crash_rep: true, crash_label: 'subject_vehicle_initiated', crash_own_kind: 'animal', label: 'subject_vehicle_initiated' }),
    ];
    const cs = crashLabels(rows);
    expect(cs.length).toBe(2);
    const k = cs.find((c) => c.incident_key === 'K')!;
    expect([k.label, k.confidence, k.reports]).toEqual(['other_party', 'medium', 2]);
    expect(cs.find((c) => c.incident_key === 'L')!.ownKind).toBe('animal');
    expect(ownKindCounts(cs)).toEqual({ fixed_object: 0, animal: 1, road_user: 0, other: 0 });
  });
});

describe('half-year series with a missingness guard', () => {
  const mk = (month: string, label: CrashLabel['label'], rule = 'RESP-OTH-1'): CrashLabel =>
    ({ program: 'p', incident_key: Math.random().toString(36), month, label, confidence: 'high', rule, ownKind: null, reports: 1, severity: 'none' });
  const crashes = [
    ...Array.from({ length: 20 }, () => mk('2024-02', 'subject_vehicle_initiated')),
    ...Array.from({ length: 20 }, () => mk('2024-03', 'other_party')),
    ...Array.from({ length: 10 }, () => mk('2024-03', 'indeterminate', 'RESP-IND-1')),
    ...Array.from({ length: 5 }, () => mk('2025-02', 'subject_vehicle_initiated')),
    ...Array.from({ length: 40 }, () => mk('2025-02', 'indeterminate', 'RESP-IND-1')),
  ];
  const s = byHalfYear(crashes);
  it('fills the half-years between the first and last', () => {
    expect(s.map((p) => p.period)).toEqual(['2024H1', '2024H2', '2025H1']);
    expect(halfOf('2024-07')).toBe('2024H2');
  });
  it('own share among labelled with a Wilson interval, and the envelope over all crashes', () => {
    const p = s[0];
    expect([p.n, p.labelled, p.own, p.missing]).toEqual([50, 40, 20, 10]);
    expect(p.ownShare![0]).toBeCloseTo(0.5, 9);
    expect(p.envelope![0]).toBeCloseTo(0.4, 9);
    expect(p.envelope![1]).toBeCloseTo(0.6, 9);
  });
  it('suppresses half-years with fewer than 30 labelled crashes and flags jumps in the missing share', () => {
    expect(s[2].suppressed).toBe(true);
    expect(s[2].ownShare).toBeNull();
    expect(s[1].n).toBe(0);
    expect(s[2].comparabilityBreak).toBe(false); // previous half-year is empty, so no comparison
    const t = byHalfYear([...crashes, ...Array.from({ length: 2 }, () => mk('2024-08', 'other_party'))]);
    expect(t[2].comparabilityBreak).toBe(true); // 0% missing -> 89% missing
  });
});

describe('real data', () => {
  const resp = json('responsibility.json') as RespFile;
  const cs = crashLabels(parseRows(resp));
  it('GM Cruise is counted once per crash (about 156), not per report (304)', () => {
    const cruise = cs.filter((c) => c.program === 'gm_cruise_ads');
    expect(cruise.length).toBeGreaterThan(140);
    expect(cruise.length).toBeLessThan(170);
    expect(parseRows(resp).filter((r) => r.program === 'gm_cruise_ads').length).toBeGreaterThan(290);
  });
  it('Tesla L2 own motion among labelled crashes is about 80-87% in each year (flat), while cannot-tell is large', () => {
    const tesla = cs.filter((c) => c.program === 'tesla_l2');
    for (const y of ['2023', '2024', '2025']) {
      const yr = tesla.filter((c) => c.month?.startsWith(y));
      const own = yr.filter((c) => c.label === 'subject_vehicle_initiated').length;
      const lab = yr.filter((c) => c.label !== 'indeterminate').length;
      expect(own / lab).toBeGreaterThan(0.75);
      expect(own / lab).toBeLessThan(0.9);
    }
  });
});
