import { describe, expect, it } from 'vitest';
import { ci95, poissonQuantile } from './poisson';

describe('ci95', () => {
  it('k=0 gives [0, 3.689]', () => {
    const [lo, hi] = ci95(0);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(3.689, 3);
  });
  it('k=10 gives about [4.795, 18.39]', () => {
    const [lo, hi] = ci95(10);
    expect(lo).toBeCloseTo(4.795, 2);
    expect(hi).toBeCloseTo(18.39, 2);
  });
  it('k=1 gives about [0.0253, 5.572]', () => {
    const [lo, hi] = ci95(1);
    expect(lo).toBeCloseTo(0.0253, 3);
    expect(hi).toBeCloseTo(5.572, 2);
  });
  it('contains k for a range of k', () => {
    for (const k of [3, 50, 400, 5000]) {
      const [lo, hi] = ci95(k);
      expect(lo).toBeLessThan(k);
      expect(hi).toBeGreaterThan(k);
    }
  });
  it('poissonQuantile matches known values', () => {
    expect(poissonQuantile(0.5, 10)).toBe(10);
    expect(poissonQuantile(0.975, 10)).toBe(17);
  });
});
