import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { waymoBenchmark } from './claims';
import type { CompanyRow } from '../data/rates';

const rows = JSON.parse(readFileSync(new URL('../../public/data/company_reported.json', import.meta.url), 'utf8')).rows as CompanyRow[];

describe('waymoBenchmark', () => {
  it('takes the latest period per outcome and parses the interval and predicted count from the note', () => {
    const b = waymoBenchmark(rows);
    const inj = b.find((r) => r.metric === 'any_injury_reported_crash_pct_diff_vs_benchmark')!;
    expect(inj.outcome).toBe('Any-injury-reported');
    expect(inj.period).toBe('2026-06-30');
    expect(inj.pct).toBeCloseTo(-82.12, 2);
    expect(inj.lo).toBeCloseTo(-85.0, 1);
    expect(inj.hi).toBeCloseTo(-78.9, 1);
    expect(inj.crashes).toBe(183);
    expect(inj.predicted).toBeCloseTo(1023.6, 1);
  });
  it('leaves out insurance-claims rows and never invents an interval when the note does not parse', () => {
    const b = waymoBenchmark(rows);
    expect(b.some((r) => r.metric.startsWith('bi_') || r.metric.startsWith('pd_'))).toBe(false);
    const odd = waymoBenchmark([{ ...rows.find((r) => r.metric === 'any_fatal_crash_pct_diff_vs_benchmark')!, method_note: 'free text' }]);
    expect(odd[0].lo).toBeNull();
    expect(odd[0].hi).toBeNull();
  });
});
