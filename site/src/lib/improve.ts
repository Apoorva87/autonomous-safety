import type { Crash } from '../data';
import { BREAK_DATE, monthIncomplete, type LagCurve, type Point } from './metrics';
import { isRiderOnlyProgram, operatorClass } from './scope';
import { poissonRate, rateRatio, verdict, type RateRatio, type Verdict } from './stats';

// Regime-robust improvement view. Every comparison is within one program, before vs after the 2025-06-16 reporting
// rule change, on months with a fair denominator. June 2025 is excluded (mixed: some of its reports were filed under
// each set of rules), and so are recent months whose reports are still arriving.

export const MIXED_MONTH = BREAK_DATE.slice(0, 7);
export type Regime = 'pre' | 'post';
export const regimeOf = (month: string): Regime | null => (month < MIXED_MONTH ? 'pre' : month > MIXED_MONTH ? 'post' : null);

export type NumeratorId = 'robust' | 'all' | 'injury' | 'airbag' | 'stopped' | 'moving' | 'not_robust';
export type Numerator = { id: NumeratorId; label: string; test: (c: Crash) => boolean; threshold: boolean; note?: string };

const INJURY = ['minor', 'moderate', 'serious', 'fatal'];
const STILL = ['stopped', 'parked'];

/** Numerators for the forest plot. `threshold: true` marks counts the rule change is known to affect. */
export const NUMERATORS: Numerator[] = [
  { id: 'robust', label: 'Injury, air bag, tow-away (ADS) or VRU: comparable across the change', test: (c) => c.robust, threshold: false },
  { id: 'all', label: 'All reportable crashes (reporting threshold changed 2025-06-16)', test: () => true, threshold: true },
  { id: 'not_robust', label: 'Crashes without injury, air bag, tow-away or VRU (the ones that stopped being reportable)', test: (c) => !c.robust, threshold: true },
  { id: 'injury', label: 'Any injury', test: (c) => INJURY.includes(c.severity), threshold: false },
  { id: 'airbag', label: 'Air bag deployed', test: (c) => c.airbag === true, threshold: false },
  { id: 'stopped', label: 'Subject vehicle stopped or parked', test: (c) => STILL.includes(c.sv_movement ?? ''), threshold: true },
  { id: 'moving', label: 'Subject vehicle moving', test: (c) => !!c.sv_movement && c.sv_movement !== 'unknown' && !STILL.includes(c.sv_movement), threshold: true,
    note: 'Some moving minor contacts also left the data, so this cannot be separated from the threshold change.' },
];
export const NUMERATOR_BY_ID = Object.fromEntries(NUMERATORS.map((n) => [n.id, n])) as Record<NumeratorId, Numerator>;

export type MonthExposure = { month: string; exposure: number; estimate: boolean };

/**
 * Per-month exposure usable for a before/after comparison, from monthly Points (Rates' series(), one per month): months
 * with a rate-able denominator, not the mixed month, not still filling in (lag curve of the month's regime).
 */
export function usableMonths(points: Point[], lag: LagCurve, lastMonth: string): MonthExposure[] {
  return points
    .filter((p) => p.period.length === 7 && p.exposure != null && p.exposure > 0 && p.rate != null && !p.assumption)
    .filter((p) => regimeOf(p.period) != null && !monthIncomplete(lag, p.period, lastMonth))
    .map((p) => ({ month: p.period, exposure: p.exposure as number, estimate: p.exposureKind === 'estimate' }));
}

/** The crashes a program's rate counts: its own records, dated, rider-only where its miles are rider-only. */
export function countedCrashes(crashes: Crash[], program: string, riderOnly = true): Crash[] {
  const ro = riderOnly && isRiderOnlyProgram(program);
  return crashes.filter((c) => c.program === program && c.month && (!ro || operatorClass(c.operator) === 'driverless'));
}

export type RegimeSide = { k: number; e: number; months: string[]; rate: number | null; lo: number | null; hi: number | null };
export type ForestRow = {
  numerator: Numerator;
  pre: RegimeSide;
  post: RegimeSide;
  rr: RateRatio;
  verdict: Verdict;
};

function side(cs: Crash[], months: MonthExposure[], regime: Regime, test: (c: Crash) => boolean, scale: number): RegimeSide {
  const ms = months.filter((m) => regimeOf(m.month) === regime);
  const set = new Set(ms.map((m) => m.month));
  const k = cs.filter((c) => set.has(c.month!) && test(c)).length;
  const e = ms.reduce((a, m) => a + m.exposure, 0);
  const r = poissonRate(k, e, scale);
  return { k, e, months: ms.map((m) => m.month), rate: r?.rate ?? null, lo: r?.lo ?? null, hi: r?.hi ?? null };
}

/** Forest rows (one per numerator) for one program: before vs after, rate per `scale` units, rate ratio and verdict. */
export function forestRows(cs: Crash[], months: MonthExposure[], scale: number, numerators: Numerator[] = NUMERATORS): ForestRow[] {
  const estimate = months.some((m) => m.estimate);
  return numerators.map((n) => {
    const pre = side(cs, months, 'pre', n.test, scale);
    const post = side(cs, months, 'post', n.test, scale);
    const rr = rateRatio(pre.k, pre.e, post.k, post.e);
    let v = verdict(pre.e > 0 && post.e > 0 ? rr : null, { estimate });
    if (n.threshold && (v.code === 'lower' || v.code === 'higher')) {
      v = { ...v, text: `${v.text} Expected from the reporting change itself, so it is not a change in driving.` };
    }
    return { numerator: n, pre, post, rr, verdict: v };
  });
}

export type QuarterPoint = { period: string; label: string; regime: Regime; months: string[]; k: number; e: number; rate: number; lo: number; hi: number; estimate: boolean };

const quarterOf = (m: string) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Quarterly rates inside each regime (monthly miles are interpolated, so a quarter is the finest honest grain). A quarter
 * never spans the break: 2025-Q2 keeps April and May only. Quarters with fewer than `minMonths` usable months are dropped.
 */
export function quarterSeries(cs: Crash[], months: MonthExposure[], test: (c: Crash) => boolean, scale: number, minMonths = 2): QuarterPoint[] {
  const groups = new Map<string, MonthExposure[]>();
  for (const m of months) {
    const r = regimeOf(m.month);
    if (!r) continue;
    const key = `${quarterOf(m.month)}|${r}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const out: QuarterPoint[] = [];
  for (const [key, ms] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ms.length < minMonths) continue;
    const [period, regime] = key.split('|') as [string, Regime];
    const set = new Set(ms.map((m) => m.month));
    const k = cs.filter((c) => set.has(c.month!) && test(c)).length;
    const e = ms.reduce((a, m) => a + m.exposure, 0);
    const r = poissonRate(k, e, scale)!;
    const sorted = ms.map((m) => m.month).sort();
    const full = ms.length === 3;
    const label = full ? period : `${period} (${sorted.map((m) => MONTH_ABBR[Number(m.slice(5, 7)) - 1]).join('–')})`;
    out.push({ period, label, regime, months: sorted, k, e, rate: r.rate, lo: r.lo, hi: r.hi, estimate: ms.some((m) => m.estimate) });
  }
  return out;
}

/** Program setup for the view: which exposure denominates it, and why the others have none. */
export type ProgramSetup = {
  program: string;
  region: string | null;
  metric: 'perM' | 'per10kVeh' | null;
  unit: string;
  scale: number;
  why: string;
};

export const PROGRAM_SETUP: Record<string, ProgramSetup> = {
  waymo_ads: { program: 'waymo_ads', region: 'us', metric: 'perM', unit: 'crashes per million miles', scale: 1e6,
    why: 'US rider-only miles from the Waymo Safety Impact hub (2024-07 on, monthly values interpolated inside quarters); crashes with an in-vehicle operator are left out to match.' },
  gm_cruise_ads: { program: 'gm_cruise_ads', region: 'us', metric: 'perM', unit: 'crashes per million miles', scale: 1e6,
    why: 'US driverless miles are estimates for 2023-03 to 2023-09 only; Cruise stopped driverless operation in October 2023, so there is no exposure after the change.' },
  gm_supercruise: { program: 'gm_supercruise', region: 'north_america', metric: 'perM', unit: 'crashes per million miles', scale: 1e6,
    why: 'North America miles are estimates interpolated between rounded GM disclosures (including a 615-day gap and two flagged months); crashes are US reports.' },
  tesla_l2: { program: 'tesla_l2', region: 'us', metric: 'per10kVeh', unit: 'crashes per 10,000 vehicle-years', scale: 1e4,
    why: 'No NHTSA-comparable miles exist; this is per vehicle-year of an estimated US fleet whose definition changes over the years. Per vehicle is not a safety rate when miles per vehicle with the system engaged change fast (FSD miles grew 2.6x in a year).' },
  zoox_ads: { program: 'zoox_ads', region: null, metric: null, unit: '', scale: 1, why: 'No US miles are disclosed (California DMV testing miles are not a denominator for SGO crashes).' },
  tesla_robotaxi: { program: 'tesla_robotaxi', region: null, metric: null, unit: '', scale: 1, why: 'No miles are disclosed and service began after the change, so there is no before.' },
  other_ads: { program: 'other_ads', region: null, metric: null, unit: '', scale: 1, why: 'No exposure is collected for other reporters.' },
  other_l2: { program: 'other_l2', region: null, metric: null, unit: '', scale: 1, why: 'No exposure is collected for other reporters.' },
};
