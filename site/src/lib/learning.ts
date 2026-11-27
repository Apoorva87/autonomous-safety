import { ci95 } from './poisson';
import { BREAK_DATE, monthIncomplete, series, type CountsByMonth, type ExposureRow, type Kind, type LagCurve, type Metric, type Point } from './metrics';
import type { Scenario } from '../state/scenario';

// Learning curves: crash rate against cumulative exposure. Points are calendar quarters built from the
// MONTHLY exposure rows of one region; a quarter is kept only when all three months have exposure.
// Cumulative miles start from the first disclosed month (plus an optional base) and are never the company's
// lifetime total unless a lifetime base is supplied.

export type LearnPoint = {
  period: string; // "2025-Q3" or "2025-07"
  months: string[];
  k: number;
  kAdj: number;
  miles: number;
  /** Miles accumulated from the first disclosed month through the end of this period (plus base). */
  cumMiles: number;
  rate: number; // crashes per million miles
  lo: number;
  hi: number;
  /** Miles per crash; null when there were no crashes (then mpcLo is a lower bound). */
  mpc: number | null;
  mpcLo: number;
  mpcHi: number | null;
  kind: Kind;
  lowSample: boolean;
  /** Reports for the latest months are still arriving, so the count is probably too low. */
  recent: boolean;
  /** The period contains the month of the 2025-06-16 rule change: part of it was filed under the old rules, part under the new. */
  straddlesBreak: boolean;
  /** Pipeline note when one of the months rests on an unreliable monthly miles split (>3x adjacent segments). */
  flag: string | null;
  scenario: boolean;
  sourceIds: string[];
};

/** The break falls inside a month (2025-06-16), so a period that includes that month straddles it. */
export const straddlesBreak = (months: string[]) => months.includes(BREAK_DATE.slice(0, 7));

export const quarterOf = (month: string) => `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;

const KIND_RANK: Record<Kind, number> = { reported: 0, derived: 1, estimate: 2 };

/** Monthly Points over every year that has exposure, using the same scope-matched series() as the Rates tab. */
export function monthlyPoints(
  counts: CountsByMonth | null,
  exposure: ExposureRow[],
  scenario: Scenario,
  opts: { program: string; region: string; lastMonth: string; lag?: LagCurve },
): Point[] {
  const years = exposure
    .filter((r) => r.program === opts.program && r.region === opts.region && r.metric === 'miles' && r.period.length === 7)
    .map((r) => Number(r.period.slice(0, 4)));
  if (years.length === 0) return [];
  const y0 = Math.min(...years);
  const y1 = Math.min(Math.max(...years), Number(opts.lastMonth.slice(0, 4)));
  const out: Point[] = [];
  for (let y = y0; y <= y1; y++) {
    out.push(
      ...series(counts, exposure, scenario, {
        program: opts.program, region: opts.region, metric: 'perM', grain: 'month', year: y, lastMonth: opts.lastMonth, lag: opts.lag,
      }),
    );
  }
  return out;
}

/** Group monthly points into calendar quarters (or keep months) and accumulate miles. */
export function learningCurve(
  monthly: Point[],
  opts: { group: 'quarter' | 'month'; lastMonth: string; lag?: LagCurve; base?: number },
): LearnPoint[] {
  const valid = monthly
    .filter((p) => p.exposure != null && p.exposure > 0 && !p.notes.some((n) => /assumed miles per vehicle/.test(n)))
    .sort((a, b) => a.period.localeCompare(b.period));
  const groups = new Map<string, Point[]>();
  for (const p of valid) {
    const g = opts.group === 'quarter' ? quarterOf(p.period) : p.period;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const need = opts.group === 'quarter' ? 3 : 1;
  const out: LearnPoint[] = [];
  let cum = opts.base ?? 0;
  for (const [period, pts] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const miles = pts.reduce((a, p) => a + (p.exposure as number), 0);
    cum += miles;
    if (pts.length < need) continue; // incomplete quarter: miles still count toward the running total
    const k = pts.reduce((a, p) => a + p.k, 0);
    const kAdj = pts.reduce((a, p) => a + p.kAdj, 0);
    const [lo0, hi0] = ci95(k);
    const s = k > 0 ? kAdj / k : 1;
    const loK = lo0 * s;
    const hiK = hi0 * s;
    const kind = pts.reduce<Kind>((a, p) => (p.exposureKind && KIND_RANK[p.exposureKind] > KIND_RANK[a] ? p.exposureKind : a), 'reported');
    const last = pts[pts.length - 1].period;
    out.push({
      period, months: pts.map((p) => p.period), k, kAdj, miles, cumMiles: cum,
      rate: (kAdj / miles) * 1e6, lo: (loK / miles) * 1e6, hi: (hiK / miles) * 1e6,
      mpc: kAdj > 0 ? miles / kAdj : null,
      mpcLo: miles / hiK,
      mpcHi: loK > 0 ? miles / loK : null,
      kind,
      lowSample: k < 10 || kind === 'estimate',
      recent: monthIncomplete(opts.lag, last, opts.lastMonth),
      straddlesBreak: straddlesBreak(pts.map((p) => p.period)),
      flag: pts.find((p) => p.flag)?.flag ?? null,
      scenario: pts.some((p) => p.scenario),
      sourceIds: [...new Set(pts.flatMap((p) => p.sourceIds))],
    });
  }
  return out;
}

/** Monthly Points for any metric over 2021 to the last month (for the timeline). Months without exposure have a null rate. */
export function monthlySeries(
  counts: CountsByMonth | null,
  exposure: ExposureRow[],
  scenario: Scenario,
  opts: { program: string; region: string; metric: Metric; lastMonth: string; lag?: LagCurve },
): Point[] {
  const out: Point[] = [];
  for (let y = 2021; y <= Number(opts.lastMonth.slice(0, 4)); y++) {
    out.push(
      ...series(counts, exposure, scenario, {
        program: opts.program, region: opts.region, metric: opts.metric, grain: 'month', year: y, lastMonth: opts.lastMonth, lag: opts.lag,
      }),
    );
  }
  return out;
}
