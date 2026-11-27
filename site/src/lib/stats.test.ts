import { describe, expect, it } from 'vitest';
import { betaInc, clopperPearson, cochranArmitage, rateRatio, twoProportionZ, verdict, wilson } from './stats';

// Waymo US miles, pre (2024-07..2025-05) and post (2025-07..2026-06), from exposure.json; review counts.
const E1 = 65740177;
const E2 = 175363998;

describe('wilson', () => {
  it('matches the reference values', () => {
    const [p, lo, hi] = wilson(26, 365)!;
    expect(p).toBeCloseTo(0.07123, 4);
    expect(lo).toBeCloseTo(0.04907, 4);
    expect(hi).toBeCloseTo(0.10233, 4);
    expect(wilson(0, 10)![1]).toBe(0);
    expect(wilson(0, 10)![2]).toBeCloseTo(0.27754, 4);
    expect(wilson(10, 10)![1]).toBeCloseTo(0.72246, 4);
    expect(wilson(3, 0)).toBeNull();
  });
});

describe('exact binomial and incomplete beta', () => {
  it('betaInc is a CDF', () => {
    expect(betaInc(2, 3, 0)).toBe(0);
    expect(betaInc(2, 3, 1)).toBe(1);
    expect(betaInc(1, 1, 0.3)).toBeCloseTo(0.3, 10);
    expect(betaInc(2, 2, 0.5)).toBeCloseTo(0.5, 10);
  });
  it('Clopper-Pearson for 0 of 10 and 5 of 10', () => {
    const [lo0, hi0] = clopperPearson(0, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.30850, 4);
    const [lo, hi] = clopperPearson(5, 10);
    expect(lo).toBeCloseTo(0.18709, 4);
    expect(hi).toBeCloseTo(0.81291, 4);
  });
});

describe('rateRatio (conditional exact)', () => {
  it('reproduces the review: Waymo robust 221 -> 609 is RR 1.03 [0.88, 1.21]', () => {
    const r = rateRatio(221, E1, 609, E2);
    expect(r.rr!).toBeCloseTo(1.033, 3);
    expect(r.lo!).toBeCloseTo(0.884, 3);
    expect(r.hi!).toBeCloseTo(1.210, 3);
  });
  it('reproduces the review: Waymo all crashes 723 -> 1,053 is RR 0.55 [0.50, 0.60]', () => {
    const r = rateRatio(723, E1, 1053, E2);
    expect(r.rr!).toBeCloseTo(0.546, 3);
    expect(r.lo!).toBeCloseTo(0.496, 3);
    expect(r.hi!).toBeCloseTo(0.601, 3);
  });
  it('small counts and edge cases', () => {
    const r = rateRatio(5, 1e6, 3, 1e6);
    expect(r.rr!).toBeCloseTo(0.6, 9);
    expect(r.lo!).toBeCloseTo(0.0932, 3);
    expect(r.hi!).toBeCloseTo(3.084, 2);
    const z = rateRatio(0, 1e6, 4, 1e6);
    expect(z.rr).toBeNull();
    expect(z.lo!).toBeCloseTo(0.660, 2);
    expect(z.hi).toBeNull();
    expect(rateRatio(3, 0, 4, 1).rr).toBeNull();
  });
});

describe('verdict', () => {
  it('reads an interval that contains 1 as no detectable change, never as safer', () => {
    const v = verdict(rateRatio(221, E1, 609, E2));
    expect(v.code).toBe('no_change');
    expect(v.text).toMatch(/No detectable change/);
    expect(v.text).not.toMatch(/safer|safe|better|worse|fault/i);
  });
  it('lower and higher only when the whole interval is on one side', () => {
    expect(verdict(rateRatio(723, E1, 1053, E2)).code).toBe('lower');
    expect(verdict(rateRatio(100, 1e6, 300, 1e6)).code).toBe('higher');
    for (const v of [verdict(rateRatio(723, E1, 1053, E2)), verdict(rateRatio(100, 1e6, 300, 1e6))]) {
      expect(v.text).not.toMatch(/safer|safe|better|worse|fault/i);
    }
  });
  it('too few events or no exposure on one side is insufficient / no denominator', () => {
    expect(verdict(rateRatio(3, 1e6, 40, 1e6)).code).toBe('insufficient');
    expect(verdict(rateRatio(8, 1e6, 9, 1e6)).code).toBe('insufficient');
    expect(verdict(rateRatio(30, 1e6, 0, 0)).code).toBe('no_denominator');
    expect(verdict(null).code).toBe('no_denominator');
  });
  it('flags estimated denominators', () => {
    expect(verdict(rateRatio(221, E1, 609, E2), { estimate: true }).text).toMatch(/estimates/);
  });
});

describe('tests for mix shifts', () => {
  it('two-proportion z', () => {
    const t = twoProportionZ(75, 943, 198, 1442)!; // Waymo heavy truck or bus share 8.0% -> 13.7%
    expect(t.z).toBeGreaterThan(4);
    expect(t.p).toBeLessThan(1e-4);
    expect(twoProportionZ(1, 0, 1, 2)).toBeNull();
  });
  it('Cochran-Armitage on a flat and a rising series', () => {
    expect(Math.abs(cochranArmitage([10, 10, 10], [100, 100, 100])!.z)).toBeLessThan(1e-9);
    const up = cochranArmitage([5, 15, 30], [100, 100, 100])!;
    expect(up.z).toBeGreaterThan(3);
    expect(up.p).toBeLessThan(0.01);
  });
});
