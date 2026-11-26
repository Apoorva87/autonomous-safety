// Exact (Garwood) Poisson confidence intervals via gamma quantiles.
// For k observed events: lo = Gamma(k, 1) quantile at alpha/2, hi = Gamma(k + 1, 1) quantile at 1 - alpha/2.

const EPS = 1e-14;

function lnGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9)
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

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // continued fraction for Q(a, x)
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Quantile of Gamma(shape a, scale 1) by bracketing and bisection. */
export function gammaQuantile(p: number, a: number): number {
  if (p <= 0) return 0;
  let lo = 0;
  let hi = Math.max(1, a);
  while (gammaP(a, hi) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(a, mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, hi)) break;
  }
  return (lo + hi) / 2;
}

/** Exact 95% confidence interval for a Poisson mean given k observed events. */
export function ci95(k: number): [number, number] {
  if (!(k >= 0)) throw new Error('ci95 needs k >= 0');
  const lo = k === 0 ? 0 : gammaQuantile(0.025, k);
  const hi = gammaQuantile(0.975, k + 1);
  return [lo, hi];
}

/** Poisson cdf P(X <= n) for mean mu. */
export function poissonCdf(n: number, mu: number): number {
  if (n < 0) return 0;
  return 1 - gammaP(n + 1, mu);
}

/** Smallest integer n with P(X <= n) >= p (the Poisson quantile). */
export function poissonQuantile(p: number, mu: number): number {
  if (mu <= 0) return 0;
  let lo = 0;
  let hi = Math.max(10, Math.ceil(mu + 10 * Math.sqrt(mu) + 10));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (poissonCdf(mid, mu) >= p) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
