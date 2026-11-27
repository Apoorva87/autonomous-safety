// Small, exact statistics used by the regime-robust views. No dependencies.
//   wilson        95% Wilson score interval for a share
//   clopperPearson exact binomial interval (via the regularized incomplete beta function)
//   rateRatio     post/pre rate ratio with the conditional exact interval (Clopper-Pearson on k2 / (k1 + k2))
//   verdict       plain-language reading of a rate-ratio interval (never "safer" or "at fault")
//   twoProportionZ, cochranArmitage  tests used to badge a mix shift as surviving the controls

import { ci95 } from './poisson';

const Z95 = 1.959963984540054;

/** Wilson score interval for k of n: [share, lo, hi]. n = 0 gives nulls. */
export function wilson(k: number, n: number, z = Z95): [number, number, number] | null {
  if (!(n > 0)) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [p, Math.max(0, c - h), Math.min(1, c + h)];
}

function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaInc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Inverse of I_x(a, b) in x, by bisection. */
function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (betaInc(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Exact (Clopper-Pearson) 95% interval for a binomial proportion k of n. */
export function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] {
  if (!(n > 0)) return [0, 1];
  const lo = k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1);
  const hi = k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k);
  return [lo, hi];
}

export type RateRatio = { rr: number | null; lo: number | null; hi: number | null; k1: number; e1: number; k2: number; e2: number };

/**
 * Rate ratio after / before = (k2 / e2) / (k1 / e1), with the conditional exact 95% interval: given k1 + k2 events,
 * k2 is binomial with p = e2 r2 / (e1 r1 + e2 r2); Clopper-Pearson on k2 / (k1 + k2) transformed by e1 / e2.
 * Null fields when an exposure is missing or both counts are zero.
 */
export function rateRatio(k1: number, e1: number, k2: number, e2: number): RateRatio {
  const out: RateRatio = { rr: null, lo: null, hi: null, k1, e1, k2, e2 };
  if (!(e1 > 0) || !(e2 > 0) || k1 + k2 === 0) return out;
  const [plo, phi] = clopperPearson(k2, k1 + k2);
  const f = e1 / e2;
  out.rr = k1 > 0 ? (k2 / e2) / (k1 / e1) : null;
  out.lo = plo >= 1 ? null : (plo / (1 - plo)) * f;
  out.hi = phi >= 1 ? null : (phi / (1 - phi)) * f;
  return out;
}

/** Rate and exact Poisson interval per `scale` units of exposure. */
export function poissonRate(k: number, e: number, scale: number): { rate: number; lo: number; hi: number } | null {
  if (!(e > 0)) return null;
  const [lo, hi] = ci95(k);
  return { rate: (k / e) * scale, lo: (lo / e) * scale, hi: (hi / e) * scale };
}

export type VerdictCode = 'no_change' | 'lower' | 'higher' | 'insufficient' | 'no_denominator';
export type Verdict = { code: VerdictCode; text: string };

/** Fewer events than this in either regime, or in both together, is "insufficient data". */
export const MIN_EVENTS_EACH = 5;
export const MIN_EVENTS_TOTAL = 20;

const pctChange = (x: number) => `${x >= 1 ? '+' : '−'}${Math.abs(Math.round((x - 1) * 100))}%`;

/**
 * A plain-language reading of a rate-ratio interval. Wording describes the reported rate only: it never says safer,
 * riskier, better or at fault. `estimate` adds that the denominator is an estimate.
 */
export function verdict(r: RateRatio | null, opts: { estimate?: boolean } = {}): Verdict {
  if (r == null || !(r.e1 > 0) || !(r.e2 > 0)) return { code: 'no_denominator', text: 'No fair denominator on both sides of 2025-06-16: no before/after reading.' };
  if (r.k1 < MIN_EVENTS_EACH || r.k2 < MIN_EVENTS_EACH || r.k1 + r.k2 < MIN_EVENTS_TOTAL || r.lo == null || r.hi == null || r.rr == null) {
    return { code: 'insufficient', text: `Insufficient data: ${r.k1} crashes before and ${r.k2} after are too few to read a change.` };
  }
  const tail = opts.estimate ? ' The miles are estimates, so read this as rough.' : '';
  const range = `rate ratio ${r.rr.toFixed(2)}, 95% interval ${r.lo.toFixed(2)} to ${r.hi.toFixed(2)}`;
  if (r.lo <= 1 && r.hi >= 1) {
    return { code: 'no_change', text: `No detectable change (${range}): anything from ${pctChange(r.lo)} to ${pctChange(r.hi)} is consistent with the data.${tail}` };
  }
  if (r.hi < 1) return { code: 'lower', text: `Reported rate lower after 2025-06-16 (${range}).${tail}` };
  return { code: 'higher', text: `Reported rate higher after 2025-06-16 (${range}).${tail}` };
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
const twoSided = (z: number) => 2 * (1 - normCdf(Math.abs(z)));

/** Two-proportion z test (pooled): z > 0 when the second share is larger. */
export function twoProportionZ(k1: number, n1: number, k2: number, n2: number): { z: number; p: number } | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (k2 / n2 - k1 / n1) / se;
  return { z, p: twoSided(z) };
}

/** Cochran-Armitage trend test across ordered groups (scores 0, 1, 2, ...). */
export function cochranArmitage(ks: number[], ns: number[]): { z: number; p: number } | null {
  const N = ns.reduce((a, b) => a + b, 0);
  const K = ks.reduce((a, b) => a + b, 0);
  if (!(N > 0) || ks.length < 2) return null;
  const p = K / N;
  if (p === 0 || p === 1) return { z: 0, p: 1 };
  const sbar = ns.reduce((a, n, i) => a + i * n, 0) / N;
  const T = ks.reduce((a, k, i) => a + i * (k - ns[i] * p), 0);
  const V = p * (1 - p) * ns.reduce((a, n, i) => a + n * (i - sbar) ** 2, 0);
  if (!(V > 0)) return { z: 0, p: 1 };
  const z = T / Math.sqrt(V);
  return { z, p: twoSided(z) };
}
